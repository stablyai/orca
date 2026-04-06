import {
  chmodSync,
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import {
  getRuntimeMetadataPath,
  getRuntimeRecordPath,
  isRuntimeRecordFileName,
  type RuntimeMetadata
} from '../../shared/runtime-bootstrap'

let cachedWindowsUserSid: string | null | undefined

export function writeRuntimeMetadata(userDataPath: string, metadata: RuntimeMetadata): void {
  const metadataPath = getRuntimeMetadataPath(userDataPath)
  writeMetadataFile(metadataPath, metadata)
}

export function writeRuntimeRecord(userDataPath: string, metadata: RuntimeMetadata): void {
  writeMetadataFile(getRuntimeRecordPath(userDataPath, metadata.runtimeId), metadata)
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

export function readRuntimeRecord(userDataPath: string, runtimeId: string): RuntimeMetadata | null {
  const recordPath = getRuntimeRecordPath(userDataPath, runtimeId)
  if (!existsSync(recordPath)) {
    return null
  }
  return JSON.parse(readFileSync(recordPath, 'utf-8')) as RuntimeMetadata
}

export function listRuntimeRecords(userDataPath: string): RuntimeMetadata[] {
  if (!existsSync(userDataPath)) {
    return []
  }
  return readdirSync(userDataPath)
    .filter((fileName) => isRuntimeRecordFileName(fileName))
    .flatMap((fileName) => {
      try {
        return [JSON.parse(readFileSync(join(userDataPath, fileName), 'utf-8')) as RuntimeMetadata]
      } catch {
        return []
      }
    })
}

export function clearRuntimeRecord(userDataPath: string, runtimeId: string): void {
  rmSync(getRuntimeRecordPath(userDataPath, runtimeId), { force: true })
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
  // attach to a live Orca runtime. Every published record must stay scoped to
  // the current user even when we retain multiple per-runtime records for
  // stale-bootstrap recovery.
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
