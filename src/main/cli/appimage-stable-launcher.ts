import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LINUX_CLI_COMMAND_NAME } from './bundled-cli-launcher-path'
import { quoteShell } from './cli-install-path-format'

const LAUNCHER_DIRECTORY_NAME = 'launcher'
const LIVE_ENDPOINT_NAME = 'live'
const INSTALLED_ENDPOINT_NAME = 'installed'
const LAUNCHER_MARKER = '# orca-appimage-stable-launcher'
const LAUNCHER_WAIT_SECONDS = 5
const LAUNCHER_MAX_BYTES = 16 * 1024

export type AppImageLauncherEndpoint = 'live' | 'installed'

export function resolveAppImageStableLauncherPath(cacheRootPath: string): string {
  return join(resolve(cacheRootPath), LAUNCHER_DIRECTORY_NAME, LINUX_CLI_COMMAND_NAME)
}

export function resolveAppImageLauncherEndpointPath(
  cacheRootPath: string,
  endpoint: AppImageLauncherEndpoint
): string {
  return join(
    dirname(resolveAppImageStableLauncherPath(cacheRootPath)),
    endpoint === 'live' ? LIVE_ENDPOINT_NAME : INSTALLED_ENDPOINT_NAME
  )
}

export function isAppImageStableLauncherReady(cacheRootPath: string): boolean {
  const launcherPath = resolveAppImageStableLauncherPath(cacheRootPath)
  return isExactExecutableLauncher(launcherPath, buildStableLauncherScript(cacheRootPath))
}

/** Ensures the persistent wrapper exists without publishing an endpoint. */
export function ensureAppImageStableLauncher(cacheRootPath: string): string | null {
  return ensureAppImageStableLauncherFile(cacheRootPath)
}

/** Removes the legacy live endpoint only when it is a symlink. */
export function removeAppImageLegacyLiveEndpoint(cacheRootPath: string): void {
  const endpointPath = resolveAppImageLauncherEndpointPath(cacheRootPath, 'live')
  try {
    if (lstatSync(endpointPath).isSymbolicLink()) {
      unlinkSync(endpointPath)
    }
  } catch {}
}

export function publishAppImageLauncherEndpoint(
  cacheRootPath: string,
  endpoint: 'installed',
  targetPath: string
): string | null {
  const launcherPath = ensureAppImageStableLauncherFile(cacheRootPath)
  if (!launcherPath) {
    return null
  }

  const endpointPath = resolveAppImageLauncherEndpointPath(cacheRootPath, endpoint)
  const temporaryPath = join(dirname(endpointPath), `.${endpoint}-${process.pid}-${randomUUID()}`)
  try {
    symlinkSync(targetPath, temporaryPath)
    renameSync(temporaryPath, endpointPath)
    return launcherPath
  } catch {
    return null
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch {}
  }
}

function ensureAppImageStableLauncherFile(cacheRootPath: string): string | null {
  const launcherPath = resolveAppImageStableLauncherPath(cacheRootPath)
  const content = buildStableLauncherScript(cacheRootPath)
  try {
    mkdirSync(dirname(launcherPath), { recursive: true })
    if (!installLauncher(launcherPath, content)) {
      return null
    }
    return launcherPath
  } catch {
    return null
  }
}

function installLauncher(launcherPath: string, content: string): boolean {
  if (isExactExecutableLauncher(launcherPath, content)) {
    return true
  }
  const temporaryPath = join(
    dirname(launcherPath),
    `.${LINUX_CLI_COMMAND_NAME}-${process.pid}-${randomUUID()}`
  )
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o755 })
    if (publishLauncherIfVacant(temporaryPath, launcherPath)) {
      return true
    }
    if (!isOwnedLauncher(launcherPath)) {
      return false
    }
    return replaceOwnedLauncher(launcherPath, temporaryPath, content)
  } finally {
    unlinkIfPresent(temporaryPath)
  }
}

function replaceOwnedLauncher(
  launcherPath: string,
  replacementPath: string,
  replacementContent: string
): boolean {
  const displacedPath = join(
    dirname(launcherPath),
    `.orca-preserved-launcher-${process.pid}-${randomUUID()}`
  )
  try {
    renameSync(launcherPath, displacedPath)
  } catch {
    return isExactExecutableLauncher(launcherPath, replacementContent)
  }

  if (!isOwnedLauncher(displacedPath)) {
    restoreForeignLauncher(displacedPath, launcherPath)
    return false
  }

  if (
    publishLauncherIfVacant(replacementPath, launcherPath) ||
    isExactExecutableLauncher(launcherPath, replacementContent)
  ) {
    unlinkIfPresent(displacedPath)
    return true
  }

  if (publishLauncherIfVacant(displacedPath, launcherPath)) {
    unlinkIfPresent(displacedPath)
  }
  return isExactExecutableLauncher(launcherPath, replacementContent)
}

function restoreForeignLauncher(displacedPath: string, launcherPath: string): void {
  if (publishLauncherIfVacant(displacedPath, launcherPath)) {
    unlinkIfPresent(displacedPath)
  }
}

function publishLauncherIfVacant(sourcePath: string, destinationPath: string): boolean {
  try {
    linkSync(sourcePath, destinationPath)
    return true
  } catch {}
  try {
    copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL)
    return true
  } catch {
    return false
  }
}

function isExactExecutableLauncher(launcherPath: string, content: string): boolean {
  const launcher = readLauncherFile(launcherPath)
  return launcher?.executable === true && launcher.content === content
}

function isOwnedLauncher(launcherPath: string): boolean {
  return readLauncherFile(launcherPath)?.content.split('\n')[1] === LAUNCHER_MARKER
}

function readLauncherFile(launcherPath: string): { content: string; executable: boolean } | null {
  let fd: number | undefined
  try {
    fd = openSync(launcherPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > LAUNCHER_MAX_BYTES) {
      return null
    }
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) {
        return null
      }
      offset += count
    }
    const after = fstatSync(fd)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return null
    }
    return { content: bytes.toString('utf8'), executable: (before.mode & 0o111) !== 0 }
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}

function unlinkIfPresent(candidatePath: string): void {
  try {
    unlinkSync(candidatePath)
  } catch {}
}

function buildStableLauncherScript(cacheRootPath: string): string {
  const launcherDirectory = dirname(resolveAppImageStableLauncherPath(cacheRootPath))
  return `#!/usr/bin/env bash
${LAUNCHER_MARKER}
shopt -s execfail
launcher_dir=${quoteShell(launcherDirectory)}
deadline=$((SECONDS + ${LAUNCHER_WAIT_SECONDS}))
while (( SECONDS <= deadline )); do
  launcher="$launcher_dir/${INSTALLED_ENDPOINT_NAME}"
  if [[ -f "$launcher" && -x "$launcher" ]]; then
    exec "$launcher" "$@"
  fi
  sleep 0.1
done
printf 'Orca CLI is not ready; reopen Orca or register the CLI again.\\n' >&2
exit 1
`
}
