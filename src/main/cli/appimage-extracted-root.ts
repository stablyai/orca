import { lstatSync, readlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { resolveCachedAppImagePayloadRoot } from './appimage-cache-layout'
// Re-exported: callers in main keep importing the cache key from here.
export {
  readAppImageSourceOfNamespace,
  resolveAppImageCacheKey
} from '../../shared/appimage-cache-identity'
import { removeExtractedAppImagePayload } from './appimage-payload-removal'
import { LINUX_CLI_COMMAND_NAME } from './bundled-cli-launcher-path'
import {
  APPIMAGE_SOURCE_RECORD_NAME,
  appImageCacheDigest,
  appImageNamespaceKey,
  resolveAppImageCacheKey
} from '../../shared/appimage-cache-identity'
import {
  APPIMAGE_EXTRACTION_TIMEOUT_MS,
  getAppImageActiveExtractionPath,
  pruneAppImageExtractedRoots,
  trackAppImageExtraction
} from './appimage-extraction-pruning'
import {
  isAppImageStableLauncherReady,
  publishAppImageLauncherEndpoint,
  resolveAppImageLauncherEndpointPath,
  resolveAppImageStableLauncherPath
} from './appimage-stable-launcher'

const CACHE_DIR_SEGMENTS = ['orca', 'appimage'] as const
const EXTRACT_OUTPUT_DIR = 'squashfs-root'
const MAX_GENERATION_ATTEMPTS = 2
const EXTRACTION_STAGING_PREFIX = '.extract-'

export type AppImageExtractedRoot = {
  rootPath: string
  payloadLauncherPath: string
  stableLauncherPath: string
}

export type AppImageExtractRunner = (
  appImagePath: string,
  cwd: string,
  timeoutMs: number
) => Promise<void>

export type AppImageExtractionOptions = {
  appImagePath: string
  /** Where the AppImage will run from once installed, when that is not `appImagePath` yet. */
  installedAppImagePath?: string
  cacheRootPath?: string
  runExtract?: AppImageExtractRunner
  /** Absolute time (ms) by which every extraction attempt must have finished. */
  deadlineAt?: number
}

export function getAppImageCacheRootPath(homePath = homedir()): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME
  const cacheHome =
    xdgCacheHome && isAbsolute(xdgCacheHome) ? xdgCacheHome : join(homePath, '.cache')
  return join(cacheHome, ...CACHE_DIR_SEGMENTS)
}

export function resolveAppImageExtractedRoot(
  options: AppImageExtractionOptions
): AppImageExtractedRoot | null {
  const cacheKey = resolveAppImageCacheKey(options.appImagePath)
  if (!cacheKey) {
    return null
  }
  const cacheRootPath = resolveAppImageCacheRootPath(options)
  const rootPath = join(resolveAppImageNamespacePath(options), cacheKey)
  return extractedRootAt(rootPath, cacheRootPath)
}

export function isAppImageExtractedLauncherPath(
  options: AppImageExtractionOptions,
  candidatePath: string,
  launcherName = LINUX_CLI_COMMAND_NAME
): boolean {
  if (!isAbsolute(candidatePath)) {
    return false
  }
  const cacheRootPath = resolveAppImageCacheRootPath(options)
  if (
    launcherName === LINUX_CLI_COMMAND_NAME &&
    resolve(candidatePath) === resolveAppImageStableLauncherPath(cacheRootPath)
  ) {
    return true
  }

  return resolveCachedAppImagePayloadRoot(cacheRootPath, candidatePath, launcherName) !== null
}

export function isAppImageExtractionComplete(root: AppImageExtractedRoot): boolean {
  return hasPayloadLauncher(root.rootPath)
}

export function isAppImageInstalledLauncherCurrent(options: AppImageExtractionOptions): boolean {
  const root = resolveAppImageExtractedRoot(options)
  const cacheRootPath = resolveAppImageCacheRootPath(options)
  if (
    !root ||
    !isAppImageStableLauncherReady(cacheRootPath) ||
    !hasPayloadLauncher(root.rootPath)
  ) {
    return false
  }
  const endpointPath = resolveAppImageLauncherEndpointPath(cacheRootPath, 'installed')
  try {
    return resolve(dirname(endpointPath), readlinkSync(endpointPath)) === root.payloadLauncherPath
  } catch {
    return false
  }
}

export function isAppImageInstalledLauncherOwnedBySibling(
  options: AppImageExtractionOptions
): boolean {
  const cacheRootPath = resolveAppImageCacheRootPath(options)
  const endpointPath = resolveAppImageLauncherEndpointPath(cacheRootPath, 'installed')
  try {
    const targetPath = resolve(dirname(endpointPath), readlinkSync(endpointPath))
    const targetRoot = resolveCachedAppImagePayloadRoot(cacheRootPath, targetPath)
    return (
      targetRoot !== null &&
      hasPayloadLauncher(targetRoot) &&
      dirname(targetRoot) !== resolveAppImageNamespacePath(options) &&
      dirname(targetRoot) !== resolveLegacyAppImageNamespacePath(options)
    )
  } catch {
    return false
  }
}

export async function ensureAppImageExtractedRoot(
  options: AppImageExtractionOptions
): Promise<AppImageExtractedRoot | null> {
  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
    const root = resolveAppImageExtractedRoot(options)
    if (!root || remainingExtractionMs(options) <= 0) {
      return null
    }
    const complete =
      isAppImageExtractionComplete(root) || (await extractAppImageGeneration(options, root))
    if (isCurrentGeneration(options, root)) {
      if (!complete || !isAppImageExtractionComplete(root)) {
        await cleanFailedEndpointPublication(root)
        continue
      }
      const launcherPath = publishAppImageLauncherEndpoint(
        resolveAppImageCacheRootPath(options),
        'installed',
        root.payloadLauncherPath
      )
      if (launcherPath === root.stableLauncherPath) {
        await rm(getAppImageActiveExtractionPath(root.rootPath), { force: true }).catch(() => {})
        await recordAppImageSource(dirname(root.rootPath), installedPathOf(options))
        return root
      }
    }
    await cleanFailedEndpointPublication(root)
  }
  return null
}

/**
 * Unpacks the generation without publishing it as the installed CLI launcher or pruning, so a
 * desktop can prepare its daemon's copy, or an update's, without taking the `orca` command.
 */
export async function stageAppImageExtractedRoot(
  options: AppImageExtractionOptions
): Promise<AppImageExtractedRoot | null> {
  const root = resolveAppImageExtractedRoot(options)
  if (!root) {
    return null
  }
  if (!isAppImageExtractionComplete(root)) {
    await extractAppImageGeneration(options, root)
    // Why: the marker fences a launcher publish, which a staged copy never makes.
    await rm(getAppImageActiveExtractionPath(root.rootPath), { force: true }).catch(() => {})
  }
  if (!isAppImageExtractionComplete(root)) {
    return null
  }
  await recordAppImageSource(dirname(root.rootPath), installedPathOf(options))
  return root
}

async function cleanFailedEndpointPublication(root: AppImageExtractedRoot): Promise<void> {
  await rm(getAppImageActiveExtractionPath(root.rootPath), { force: true }).catch(() => {})
  await pruneAppImageExtractedRoots(root.rootPath)
}

async function extractAppImageGeneration(
  options: AppImageExtractionOptions,
  root: AppImageExtractedRoot
): Promise<boolean> {
  const namespacePath = dirname(root.rootPath)
  await mkdir(namespacePath, { recursive: true })
  const stagingPath = await mkdtemp(join(namespacePath, EXTRACTION_STAGING_PREFIX))
  const stopTracking = trackAppImageExtraction(stagingPath)
  try {
    const timeoutMs = remainingExtractionMs(options)
    if (timeoutMs <= 0) {
      return false
    }
    await (options.runExtract ?? runAppImageExtract)(options.appImagePath, stagingPath, timeoutMs)
    const extractedPath = join(stagingPath, EXTRACT_OUTPUT_DIR)
    if (!hasPayloadLauncher(extractedPath) || !isCurrentGeneration(options, root)) {
      return false
    }
    await writeFile(getAppImageActiveExtractionPath(root.rootPath), '')
    return await publishExtractedRoot(extractedPath, root)
  } catch {
    // A concurrent extractor may have published the same payload first.
    return isAppImageExtractionComplete(root)
  } finally {
    stopTracking()
    await removeExtractedAppImagePayload(stagingPath).catch(() => {})
    await rmdir(namespacePath).catch(() => {})
  }
}

function remainingExtractionMs(options: AppImageExtractionOptions): number {
  return options.deadlineAt === undefined
    ? APPIMAGE_EXTRACTION_TIMEOUT_MS
    : Math.min(APPIMAGE_EXTRACTION_TIMEOUT_MS, options.deadlineAt - Date.now())
}

/** Names the AppImage a namespace came from, so a server running from it notices that file being replaced. */
async function recordAppImageSource(namespacePath: string, appImagePath: string): Promise<void> {
  const recordPath = join(namespacePath, APPIMAGE_SOURCE_RECORD_NAME)
  const temporaryPath = `${recordPath}.${process.pid}.tmp`
  try {
    await writeFile(temporaryPath, appImagePath, { mode: 0o600 })
    await rename(temporaryPath, recordPath)
  } catch {
    // Best effort: without it a server only misses an in-place AppImage swap, as before.
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

export function resolveAppImageNamespacePath(options: AppImageExtractionOptions): string {
  return join(resolveAppImageCacheRootPath(options), appImageNamespaceKey(installedPathOf(options)))
}

function installedPathOf(options: AppImageExtractionOptions): string {
  return options.installedAppImagePath ?? options.appImagePath
}

/** The namespace pre-lease builds used for this AppImage path. */
export function resolveLegacyAppImageNamespacePath(options: AppImageExtractionOptions): string {
  return join(resolveAppImageCacheRootPath(options), appImageCacheDigest(options.appImagePath))
}

export function resolveAppImageCacheRootPath(options: AppImageExtractionOptions): string {
  return resolve(options.cacheRootPath ?? getAppImageCacheRootPath())
}

function extractedRootAt(rootPath: string, cacheRootPath: string): AppImageExtractedRoot {
  return {
    rootPath,
    payloadLauncherPath: join(rootPath, 'resources', 'bin', LINUX_CLI_COMMAND_NAME),
    stableLauncherPath: resolveAppImageStableLauncherPath(cacheRootPath)
  }
}

function isCurrentGeneration(
  options: AppImageExtractionOptions,
  root: AppImageExtractedRoot
): boolean {
  return resolveAppImageExtractedRoot(options)?.rootPath === root.rootPath
}

async function publishExtractedRoot(
  extractedPath: string,
  root: AppImageExtractedRoot
): Promise<boolean> {
  if ((await renameRoot(extractedPath, root.rootPath)) || isAppImageExtractionComplete(root)) {
    return true
  }

  // Claim the destination atomically so a raced complete winner can be restored.
  const displacedPath = `${extractedPath}.displaced`
  if (!(await renameRoot(root.rootPath, displacedPath))) {
    return (await renameRoot(extractedPath, root.rootPath)) || isAppImageExtractionComplete(root)
  }
  if (hasPayloadLauncher(displacedPath)) {
    return (await renameRoot(displacedPath, root.rootPath)) || isAppImageExtractionComplete(root)
  }
  await removeExtractedAppImagePayload(displacedPath)
  return (await renameRoot(extractedPath, root.rootPath)) || isAppImageExtractionComplete(root)
}

function hasPayloadLauncher(rootPath: string): boolean {
  try {
    const stats = lstatSync(join(rootPath, 'resources', 'bin', LINUX_CLI_COMMAND_NAME))
    return stats.isFile() && (stats.mode & 0o111) !== 0
  } catch {
    return false
  }
}

async function renameRoot(sourcePath: string, destinationPath: string): Promise<boolean> {
  try {
    await rename(sourcePath, destinationPath)
    return true
  } catch {
    return false
  }
}

/** `niceProgram` runs the extraction under `nice -n 19`. */
export async function runAppImageExtract(
  appImagePath: string,
  cwd: string,
  timeoutMs: number,
  niceProgram?: string
): Promise<void> {
  const result = await runProcess({
    program: niceProgram ?? appImagePath,
    args: niceProgram ? ['-n', '19', appImagePath, '--appimage-extract'] : ['--appimage-extract'],
    cwd,
    timeoutMs,
    maxOutputBytes: 1024 * 1024,
    terminationBarrier: true
  })
  if (result.timedOut) {
    throw new Error('AppImage extraction timed out.')
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `AppImage extraction exited ${result.code ?? 'early'}.`)
  }
}
