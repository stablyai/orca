// Prepare daemon copies in the background so a disappearing FUSE mount cannot sever them.
import { existsSync } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { resolveAppImageRuntimeIdentity } from '../appimage-runtime-identity'
import {
  isAppImageExtractionComplete,
  resolveAppImageCacheRootPath,
  resolveAppImageExtractedRoot,
  runAppImageExtract,
  stageAppImageExtractedRoot,
  type AppImageExtractRunner
} from './appimage-extracted-root'
import { pruneAppImageExtractedRoots } from './appimage-extraction-pruning'
import { leaseAppImageGenerationForCurrentProcess } from './appimage-generation-lease'
import { withAppImageRegistrationLock } from './appimage-registration-lock'
import { probeAppImageCache } from './appimage-serve-preparation'

/** How long a daemon launch waits for this launch's copy before falling back to the mount. */
export const APPIMAGE_COPY_DAEMON_WAIT_MS = 8_000
// Why `nice` alone: without an explicit I/O class, Linux derives a best-effort I/O priority from it.
const NICE_PROGRAM_PATHS = ['/usr/bin/nice', '/bin/nice'] as const
// electron-updater keeps a custom AppImage name unless it carries a version (AppImageUpdater.doInstall).
const VERSIONED_NAME = /\d+\.\d+\.\d+/
const GENERATION_EXECUTABLE_NAME = 'orca-ide'

export type AppImageCopyPreExtractionOptions = {
  /** The running AppImage; defaults to this process's validated one. */
  appImagePath?: string
  cacheRootPath?: string
  runExtract?: AppImageExtractRunner
  probeCache?: (cacheRootPath: string, appImagePath: string) => Promise<string | null>
  log?: (line: string) => void
}

let currentCopy: Promise<boolean> | null = null

const runAppImageExtractInBackground: AppImageExtractRunner = (appImagePath, cwd, timeoutMs) =>
  runAppImageExtract(appImagePath, cwd, timeoutMs, NICE_PROGRAM_PATHS.find(existsSync))

/** At launch: unpack this AppImage's copy when there is none yet. Null when nothing needs doing. */
export function startAppImageCopyPreExtraction(
  options: AppImageCopyPreExtractionOptions = {}
): Promise<boolean> | null {
  const appImagePath = options.appImagePath ?? resolveAppImageRuntimeIdentity()?.appImagePath
  if (!appImagePath || currentCopy) {
    return currentCopy
  }
  const root = resolveAppImageExtractedRoot({ ...options, appImagePath })
  if (!root) {
    return null
  }
  if (isAppImageExtractionComplete(root)) {
    void pruneIdleGenerations(root.rootPath, { ...options, appImagePath })
    return null
  }
  currentCopy = preExtract({ ...options, appImagePath }, 'this AppImage')
  // A daemon waiting on the copy must not also wait for pruning.
  void currentCopy.then(async (ready) => {
    if (ready) {
      await pruneIdleGenerations(root.rootPath, { ...options, appImagePath })
    }
  })
  return currentCopy
}

/** True when this launch's copy finished within `timeoutMs`; false at once when none is running. */
export async function waitForAppImageCopyPreExtraction(
  timeoutMs = APPIMAGE_COPY_DAEMON_WAIT_MS
): Promise<boolean> {
  if (!currentCopy) {
    return false
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([currentCopy, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/** At `update-downloaded`: unpack the downloaded AppImage into the copy its install will run from. */
export async function preExtractDownloadedAppImageUpdate(
  downloadedFile: unknown,
  /** Whether a path is electron-updater's own verified download; injected to keep Electron out. */
  isUpdateDownload: (filePath: string) => Promise<boolean>,
  options: AppImageCopyPreExtractionOptions = {}
): Promise<boolean> {
  const appImagePath = options.appImagePath ?? resolveAppImageRuntimeIdentity()?.appImagePath
  if (!appImagePath || typeof downloadedFile !== 'string' || !isAbsolute(downloadedFile)) {
    return false
  }
  const log = options.log ?? ((line: string) => console.log(line))
  try {
    // Extraction executes the file; accept only electron-updater's verified download.
    const download = await lstat(downloadedFile)
    if (!download.isFile() || !(await isUpdateDownload(downloadedFile))) {
      return false
    }
    const installedAppImagePath = predictInstalledAppImagePath(appImagePath, downloadedFile)
    // Why: the updater's `mv` keeps the file identity that keys the copy only within one filesystem.
    if (download.dev !== (await stat(dirname(installedAppImagePath))).dev) {
      log('[appimage-copy] Not unpacking the update: it installs onto another filesystem')
      return false
    }
    return await preExtract(
      { ...options, appImagePath: downloadedFile, installedAppImagePath },
      `the update ${basename(downloadedFile)}`
    )
  } catch (error) {
    log(`[appimage-copy] Not unpacking the update: ${describe(error)}`)
    return false
  }
}

export function predictInstalledAppImagePath(appImagePath: string, downloadedFile: string): string {
  const currentName = basename(appImagePath)
  return basename(downloadedFile) === currentName || !VERSIONED_NAME.test(currentName)
    ? appImagePath
    : join(dirname(appImagePath), basename(downloadedFile))
}

async function preExtract(
  options: AppImageCopyPreExtractionOptions & {
    appImagePath: string
    installedAppImagePath?: string
  },
  subject: string
): Promise<boolean> {
  const log = options.log ?? ((line: string) => console.log(line))
  const cacheRootPath = resolveAppImageCacheRootPath(options)
  try {
    const refusal = await (options.probeCache ?? probeAppImageCache)(
      cacheRootPath,
      options.appImagePath
    )
    if (refusal) {
      log(`[appimage-copy] Not unpacking ${subject}: ${refusal}`)
      return false
    }
    const startedAt = Date.now()
    log(`[appimage-copy] Unpacking ${subject} in the background into ${cacheRootPath}`)
    const root = await withAppImageRegistrationLock(cacheRootPath, () =>
      stageAppImageExtractedRoot({
        ...options,
        runExtract: options.runExtract ?? runAppImageExtractInBackground
      })
    )
    if (!root) {
      log(`[appimage-copy] Could not unpack ${subject}; terminal daemons keep the mount fallback`)
      return false
    }
    if (options.installedAppImagePath) {
      // This window's lease protects the unused update copy from pruning until installation.
      await leaseAppImageGenerationForCurrentProcess({
        execPath: join(root.rootPath, GENERATION_EXECUTABLE_NAME)
      })
    }
    log(`[appimage-copy] Unpacked ${subject} in ${Math.round((Date.now() - startedAt) / 1000)}s`)
    return true
  } catch (error) {
    log(`[appimage-copy] Could not unpack ${subject}: ${describe(error)}`)
    return false
  }
}

/** Without this, a desktop that never registers the CLI keeps every release's copy it unpacked. */
async function pruneIdleGenerations(
  keepRootPath: string,
  options: AppImageCopyPreExtractionOptions & { appImagePath: string }
): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line))
  try {
    await withAppImageRegistrationLock(resolveAppImageCacheRootPath(options), () =>
      pruneAppImageExtractedRoots(keepRootPath)
    )
  } catch (error) {
    log(`[appimage-copy] Could not prune older AppImage copies: ${describe(error)}`)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
