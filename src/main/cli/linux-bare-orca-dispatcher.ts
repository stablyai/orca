import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { copyFile, link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  hasAppImagePathEnvironment,
  resolveAppImageRuntimeIdentity
} from '../appimage-runtime-identity'
import {
  ensureAppImageExtractedRoot,
  resolveAppImageCacheRootPath
} from './appimage-extracted-root'
import { pruneAppImageExtractedRoots } from './appimage-extraction-pruning'
import { withAppImageRegistrationLock } from './appimage-registration-lock'
import { getBundledLauncherPath } from './bundled-cli-launcher-path'
import { quoteShell } from './cli-install-path-format'

// Why: marks a dispatcher this function wrote so repeat serve starts overwrite
// our own file idempotently but never clobber a user's own ~/.local/bin/orca.
const DISPATCHER_MARKER = '# orca-serve-bare-orca-dispatcher'

export type LinuxBareOrcaDispatcherOptions = {
  /** Packaged app resources root; the bundled `orca-ide` launcher lives under it. */
  resourcesPath: string
  /** Test seam — defaults to the real home directory. */
  homePath?: string
  /** Trusted caller override; production requires the complete AppImage runtime identity. */
  appImagePath?: string | null
  /** Test seam — defaults to $XDG_CACHE_HOME/orca/appimage. */
  appImageCacheRootPath?: string
  /** Test seam — defaults to running the AppImage's own `--appimage-extract`. */
  appImageExtractRunner?: (appImagePath: string, cwd: string) => Promise<void>
}

export type LinuxBareOrcaDispatcherState =
  | 'installed'
  | 'skipped-foreign'
  | 'skipped-launcher-missing'

export type LinuxBareOrcaDispatcherResult = {
  state: LinuxBareOrcaDispatcherState
  dispatcherPath: string
  /** The bundled `orca-ide` launcher the dispatcher execs. */
  target: string | null
}

// Why: on Linux the CLI installs as `orca-ide`, not bare `orca`, to avoid
// shadowing GNOME Orca's /usr/bin/orca. But the Claude Team launcher typed into
// the initial managed terminal invokes the literal `orca claude-teams`, so a
// headless serve box needs a bare-`orca` dispatcher on the managed-terminal PATH
// (~/.local/bin, which patchPackagedProcessPath puts ahead of /usr/bin). It is a
// plain file, not a managed symlink, so CliInstaller.removeLegacyLinuxCommandIfManaged
// never reclaims it.
export async function installLinuxBareOrcaDispatcher(
  options: LinuxBareOrcaDispatcherOptions
): Promise<LinuxBareOrcaDispatcherResult> {
  const dispatcherPath = join(options.homePath ?? homedir(), '.local', 'bin', 'orca')
  if (existsSync(dispatcherPath) && !(await isOwnedDispatcher(dispatcherPath))) {
    return { state: 'skipped-foreign', dispatcherPath, target: null }
  }

  const launcher = await resolveStableLauncherPath(options)
  if (!launcher) {
    return { state: 'skipped-launcher-missing', dispatcherPath, target: null }
  }

  const installed = await publishDispatcher(
    dispatcherPath,
    insertDispatcherMarker(buildBareOrcaCliScript(launcher))
  )
  return installed
    ? { state: 'installed', dispatcherPath, target: launcher }
    : { state: 'skipped-foreign', dispatcherPath, target: null }
}

/** Bare-`orca` script that execs the one Linux CLI launcher. */
export function buildBareOrcaCliScript(launcherPath: string): string {
  return `#!/usr/bin/env bash\nexec ${quoteShell(launcherPath)} "$@"\n`
}

/**
 * The launcher path this dispatcher can still reach on a later boot. Under an
 * AppImage `process.resourcesPath` is an ephemeral FUSE mount that dies with the
 * app, so extract the payload once and point at that stable copy instead.
 */
async function resolveStableLauncherPath(
  options: LinuxBareOrcaDispatcherOptions
): Promise<string | null> {
  const hasExplicitAppImagePath = Object.hasOwn(options, 'appImagePath')
  const runtimeIdentity = resolveAppImageRuntimeIdentity({ resourcesPath: options.resourcesPath })
  if (!hasExplicitAppImagePath && hasAppImagePathEnvironment() && !runtimeIdentity) {
    return null
  }
  const appImagePath = hasExplicitAppImagePath
    ? (options.appImagePath ?? null)
    : (runtimeIdentity?.appImagePath ?? null)
  if (appImagePath) {
    const extractionOptions = {
      appImagePath,
      cacheRootPath: options.appImageCacheRootPath,
      runExtract: options.appImageExtractRunner
    }
    return withAppImageRegistrationLock(
      resolveAppImageCacheRootPath(extractionOptions),
      async () => {
        const extractedRoot = await ensureAppImageExtractedRoot(extractionOptions)
        if (extractedRoot) {
          await pruneAppImageExtractedRoots(extractedRoot.rootPath)
        }
        return extractedRoot?.stableLauncherPath ?? null
      }
    )
  }
  const launcher = getBundledLauncherPath('linux', options.resourcesPath)
  // Why: getBundledLauncherPath only joins the path; guard existence so we never
  // write a script pointing at a missing launcher (which would fail at exec
  // time with a confusing error instead of the command-not-found we fix).
  return launcher && existsSync(launcher) ? launcher : null
}

function insertDispatcherMarker(script: string): string {
  return script.replace('\n', `\n${DISPATCHER_MARKER}\n`)
}

async function isOwnedDispatcher(dispatcherPath: string): Promise<boolean> {
  try {
    return (
      (await lstat(dispatcherPath)).isFile() &&
      (await readFile(dispatcherPath, 'utf8')).split('\n')[1] === DISPATCHER_MARKER
    )
  } catch {
    return false
  }
}

async function publishDispatcher(dispatcherPath: string, content: string): Promise<boolean> {
  const directoryPath = dirname(dispatcherPath)
  const temporaryPath = join(directoryPath, `.orca-dispatcher-${process.pid}-${randomUUID()}`)
  await mkdir(directoryPath, { recursive: true })
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o755 })
  try {
    if (await publishIfVacant(temporaryPath, dispatcherPath)) {
      return true
    }

    const displacedPath = join(
      directoryPath,
      `.orca-preserved-dispatcher-${process.pid}-${randomUUID()}`
    )
    try {
      await rename(dispatcherPath, displacedPath)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
      return await publishIfVacant(temporaryPath, dispatcherPath)
    }

    if (!(await isOwnedDispatcher(displacedPath))) {
      await restoreDisplacedDispatcher(displacedPath, dispatcherPath)
      return false
    }

    try {
      if (
        (await publishIfVacant(temporaryPath, dispatcherPath)) ||
        (await isExactExecutableDispatcher(dispatcherPath, content))
      ) {
        await unlink(displacedPath)
        return true
      }
      // A concurrently published foreign command owns the public path now.
      await unlink(displacedPath)
      return false
    } catch (error) {
      await restoreDisplacedDispatcher(displacedPath, dispatcherPath)
      throw error
    }
  } finally {
    await unlink(temporaryPath).catch(() => {})
  }
}

async function publishIfVacant(sourcePath: string, destinationPath: string): Promise<boolean> {
  try {
    await link(sourcePath, destinationPath)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false
    }
  }
  try {
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false
    }
    throw error
  }
}

async function restoreDisplacedDispatcher(
  displacedPath: string,
  dispatcherPath: string
): Promise<void> {
  if (await publishIfVacant(displacedPath, dispatcherPath)) {
    await unlink(displacedPath)
  }
}

async function isExactExecutableDispatcher(
  dispatcherPath: string,
  content: string
): Promise<boolean> {
  try {
    const [actual, metadata] = await Promise.all([
      readFile(dispatcherPath, 'utf8'),
      lstat(dispatcherPath)
    ])
    return metadata.isFile() && (metadata.mode & 0o111) !== 0 && actual === content
  } catch {
    return false
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
