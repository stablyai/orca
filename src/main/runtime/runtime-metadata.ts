import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { execFileSync } from 'child_process'
import { dirname } from 'path'
import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'

let cachedWindowsUserSid: string | null | undefined

export function writeRuntimeMetadata(userDataPath: string, metadata: RuntimeMetadata): void {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  writeMetadataFile(metadataPath, metadata)
}

export function readRuntimeMetadata(userDataPath: string): RuntimeMetadata | null {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  if (!existsSync(metadataPath)) {
    return null
  }
  return JSON.parse(readFileSync(metadataPath, 'utf-8')) as RuntimeMetadata
}

export function clearRuntimeMetadata(userDataPath: string): void {
  rmSync(getRuntimeMetadataPath(userDataPath), { force: true })
}

/**
 * Why: clearing metadata unconditionally on quit would race with a sibling
 * Orca process during auto-updater handoff (the new process may already
 * have written its own metadata before the old process finishes tearing
 * down). The ownership guard — pid + runtimeId must both match the values
 * the caller recorded at its own startup — keeps the clean-exit case honest
 * ('not_running' instead of 'stale_bootstrap') while refusing to erase the
 * replacement process's fresh bootstrap.
 *
 * Callers MUST capture `ownedPid` and `ownedRuntimeId` synchronously at
 * startup (or at least before any shutdown await) so the comparison below
 * reflects the process that actually wrote the file, not whatever state
 * globals happen to hold mid-teardown.
 */
export function clearRuntimeMetadataIfOwned(
  userDataPath: string,
  ownedPid: number,
  ownedRuntimeId: string
): void {
  const current = readRuntimeMetadata(userDataPath)
  if (!current) {
    return
  }
  if (current.pid !== ownedPid) {
    return
  }
  if (current.runtimeId !== ownedRuntimeId) {
    return
  }
  clearRuntimeMetadata(userDataPath)
}

function writeMetadataFile(path: string, metadata: RuntimeMetadata): void {
  const dir = dirname(path)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  hardenRuntimePath(dir, { isDirectory: true, platform: process.platform })
  const tmpFile = `${path}.tmp`
  writeFileSync(tmpFile, JSON.stringify(metadata, null, 2), {
    encoding: 'utf-8',
    mode: 0o600
  })
  hardenRuntimePath(tmpFile, { isDirectory: false, platform: process.platform })
  renameSync(tmpFile, path)
  // Why: runtime bootstrap files carry auth material that lets the local CLI
  // attach to a live Orca runtime. The published file must stay scoped to
  // the current user.
  hardenRuntimePath(path, { isDirectory: false, platform: process.platform })
}

function hardenRuntimePath(
  targetPath: string,
  options: {
    isDirectory: boolean
    platform: NodeJS.Platform
  }
): void {
  if (options.platform === 'win32') {
    bestEffortRestrictWindowsPath(targetPath)
    return
  }
  chmodSync(targetPath, options.isDirectory ? 0o700 : 0o600)
}

function bestEffortRestrictWindowsPath(targetPath: string): void {
  const currentUserSid = getCurrentWindowsUserSid()
  if (!currentUserSid) {
    return
  }
  try {
    execFileSync(
      'icacls',
      [
        targetPath,
        '/inheritance:r',
        '/grant:r',
        `*${currentUserSid}:(F)`,
        '*S-1-5-18:(F)',
        '*S-1-5-32-544:(F)'
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000
      }
    )
  } catch {
    // Why: runtime metadata hardening should not prevent Orca from starting on
    // Windows machines where icacls is unavailable or locked down differently.
  }
}

function getCurrentWindowsUserSid(): string | null {
  if (cachedWindowsUserSid !== undefined) {
    return cachedWindowsUserSid
  }
  try {
    const output = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000
    }).trim()
    const columns = parseCsvLine(output)
    cachedWindowsUserSid = columns[1] ?? null
  } catch {
    cachedWindowsUserSid = null
  }
  return cachedWindowsUserSid
}

function parseCsvLine(line: string): string[] {
  return line.split(/","/).map((part) => part.replace(/^"/, '').replace(/"$/, ''))
}
