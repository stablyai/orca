import { createHash, randomBytes } from 'node:crypto'
import {
  linkSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import {
  bestEffortFsyncDirectorySync,
  hardenExistingSecureFile,
  writeSecureFile
} from '../../shared/secure-file'
import { restrictWindowsFile } from '../../shared/secure-path-windows-acl'
import { ORCAD_MASTER_KEY_BYTES } from './orcad-secret-sealing'
import { hasErrorCode, isProcessAlive } from '../daemon/daemon-process-inspection'
import { errorMessage } from '../../shared/error-message'

// Read legacy keyring records only for migration.
export type StoredKeyState =
  | { version: 1; backend: 'os-keyring'; account: string; check: string }
  | {
      version: 1
      backend: 'host-file'
      key: string
      hostBound: boolean
      check: string
    }

type RecordRead =
  | { kind: 'absent' }
  | { kind: 'record'; stored: StoredKeyState }
  | { kind: 'unreadable'; reason: string }

function parseStoredState(raw: string): StoredKeyState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const record: Record<string, unknown> = { ...parsed }
  if (record.version !== 1 || typeof record.check !== 'string') {
    return null
  }
  if (record.backend === 'os-keyring' && typeof record.account === 'string') {
    return {
      version: 1,
      backend: 'os-keyring',
      account: record.account,
      check: record.check
    }
  }
  if (
    record.backend === 'host-file' &&
    typeof record.key === 'string' &&
    typeof record.hostBound === 'boolean'
  ) {
    return {
      version: 1,
      backend: 'host-file',
      key: record.key,
      hostBound: record.hostBound,
      check: record.check
    }
  }
  return null
}

export function decodeMasterKey(encoded: string): Buffer | null {
  const key = Buffer.from(encoded, 'base64')
  return key.length === ORCAD_MASTER_KEY_BYTES ? key : null
}

function machineTag(machineId: string | null): string {
  return createHash('sha256')
    .update(machineId ?? 'no-machine-id')
    .digest('hex')
    .slice(0, 16)
}

/** Machine-specific records prevent hosts sharing a home from overwriting each other's keys. */
export function orcadSecretStateFileName(machineId: string | null): string {
  return `orcad-secret-store-${machineTag(machineId)}.json`
}

function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
}

export function isTemporaryKeyDir(keyDir: string): boolean {
  const roots = [tmpdir(), '/tmp', '/var/tmp'].flatMap((root) => {
    try {
      return [resolve(root), realpathSync(root)]
    } catch {
      return [resolve(root)]
    }
  })
  let target = resolve(keyDir)
  try {
    target = realpathSync(target)
  } catch {}
  return roots.some((root) => isInside(root, target) || isInside(root, resolve(keyDir)))
}

export function readStoredRecord(statePath: string): RecordRead {
  let raw: string
  try {
    raw = readFileSync(statePath, 'utf8')
  } catch (error) {
    // Permission failures must not trigger key creation over an existing record.
    if (hasErrorCode(error, 'ENOENT')) {
      return { kind: 'absent' }
    }
    return {
      kind: 'unreadable',
      reason: `its key record could not be read (${String(error)})`
    }
  }
  const stored = parseStoredState(raw)
  // Never regenerate an unreadable record: it may contain the only key copy.
  return stored
    ? { kind: 'record', stored }
    : {
        kind: 'unreadable',
        reason: `its key record ${statePath} is not valid`
      }
}

export function publishRecordExclusively(path: string, record: StoredKeyState): string {
  const staging = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.staging`
  try {
    // Master-key bytes must never be published with unrestricted permissions.
    if (!writeSecureFile(staging, JSON.stringify(record), { durable: true })) {
      return `its key record ${path} could not be restricted to this user`
    }
    try {
      linkSync(staging, path)
    } catch (error) {
      if (hasErrorCode(error, 'EEXIST')) {
        return 'exists'
      }
      throw error
    }
    bestEffortFsyncDirectorySync(dirname(path))
    return 'published'
  } catch (error) {
    return `its key record ${path} could not be written (${errorMessage(error)})`
  } finally {
    rmSync(staging, { force: true })
  }
}

export function replaceRecord(
  path: string,
  record: StoredKeyState,
  expected: StoredKeyState
): string {
  const staging = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.staging`
  try {
    if (!writeSecureFile(staging, JSON.stringify(record), { durable: true })) {
      return `its key record ${path} could not be restricted to this user`
    }
    const current = readStoredRecord(path)
    if (
      current.kind !== 'record' ||
      current.stored.backend !== expected.backend ||
      current.stored.check !== expected.check
    ) {
      return 'changed'
    }
    renameSync(staging, path)
    bestEffortFsyncDirectorySync(dirname(path))
    return 'replaced'
  } catch (error) {
    return `its key record ${path} could not be written (${errorMessage(error)})`
  } finally {
    rmSync(staging, { force: true })
  }
}

/** Sweep only this machine's dead-writer staging files; NFS peer PIDs cannot be judged locally. */
export function sweepStaleRecordStaging(statePath: string): void {
  const dir = dirname(statePath)
  const prefix = `${basename(statePath)}.`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  for (const name of names) {
    const pid = name.startsWith(prefix)
      ? /^(\d+)\.[0-9a-f]{8}\.staging$/.exec(name.slice(prefix.length))?.[1]
      : undefined
    if (!pid || Number(pid) === process.pid || isProcessAlive(Number(pid))) {
      continue
    }
    const path = join(dir, name)
    try {
      const stat = lstatSync(path)
      if (stat.isFile() && (uid === null || stat.uid === uid)) {
        rmSync(path, { force: true })
      }
    } catch {}
  }
}

export async function restrictExistingRecord(path: string): Promise<boolean> {
  try {
    // Verify Windows ACL changes explicitly; the general hardening helper cannot confirm them.
    if (process.platform === 'win32') {
      return await restrictWindowsFile(path)
    }
    hardenExistingSecureFile(path)
    return (statSync(path).mode & 0o077) === 0
  } catch {
    return false
  }
}
