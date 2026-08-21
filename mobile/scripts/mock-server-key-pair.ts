import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import nacl from 'tweetnacl'

const LOCK_ATTEMPTS = 50
const LOCK_WAIT_MS = 10
const RENAME_ATTEMPTS = 5
const RENAME_WAIT_MS = 25
const lockWaitSignal = new Int32Array(new SharedArrayBuffer(4))

type KeyReadResult =
  | { keyPair: nacl.BoxKeyPair; reason?: never }
  | { keyPair?: never; reason: string }

type KeyLockResult =
  | { fd: number; lockFile: string; keyPair?: never }
  | { fd?: never; lockFile?: never; keyPair: nacl.BoxKeyPair }

type KeyWarningLogger = Pick<Console, 'warn'>

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function readKeyPair(keyFile: string): KeyReadResult {
  try {
    const encoded = readFileSync(keyFile, 'utf-8').trim()
    if (!encoded) {
      return { reason: 'empty' }
    }
    const decoded = Buffer.from(encoded, 'base64')
    if (decoded.toString('base64') !== encoded) {
      return { reason: 'invalid base64' }
    }
    if (decoded.length !== nacl.box.secretKeyLength) {
      return { reason: `wrong length (${decoded.length} bytes)` }
    }
    return { keyPair: nacl.box.keyPair.fromSecretKey(Uint8Array.from(decoded)) }
  } catch (error) {
    return { reason: errnoCode(error) === 'ENOENT' ? 'missing' : 'unreadable' }
  }
}

function acquireKeyLock(keyFile: string): KeyLockResult {
  const lockFile = `${keyFile}.lock`
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      return { fd: openSync(lockFile, 'wx', 0o600), lockFile }
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') {
        throw error
      }
      const concurrent = readKeyPair(keyFile)
      if (concurrent.keyPair) {
        return { keyPair: concurrent.keyPair }
      }
      if (attempt < LOCK_ATTEMPTS - 1) {
        Atomics.wait(lockWaitSignal, 0, 0, LOCK_WAIT_MS)
      }
    }
  }
  const winner = readKeyPair(keyFile)
  if (winner.keyPair) {
    return { keyPair: winner.keyPair }
  }
  try {
    return { fd: openSync(lockFile, 'wx', 0o600), lockFile }
  } catch (error) {
    if (errnoCode(error) !== 'EEXIST') {
      throw error
    }
    const lateWinner = readKeyPair(keyFile)
    if (lateWinner.keyPair) {
      return { keyPair: lateWinner.keyPair }
    }
  }
  throw new Error(
    `[mock] Key file lock ${lockFile} remained busy; remove it if no mock server is running`
  )
}

function renameKeyFile(temporaryFile: string, keyFile: string): void {
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      renameSync(temporaryFile, keyFile)
      return
    } catch (error) {
      if (
        !['EACCES', 'EBUSY', 'EPERM'].includes(errnoCode(error) ?? '') ||
        attempt === RENAME_ATTEMPTS - 1
      ) {
        throw error
      }
      Atomics.wait(lockWaitSignal, 0, 0, RENAME_WAIT_MS)
    }
  }
}

function persistKeyPair(keyFile: string, keyPair: nacl.BoxKeyPair): void {
  const temporaryFile = `${keyFile}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryFile, Buffer.from(keyPair.secretKey).toString('base64'), {
      flag: 'wx',
      mode: 0o600
    })
    if (process.platform !== 'win32') {
      chmodSync(temporaryFile, 0o600)
    }
    renameKeyFile(temporaryFile, keyFile)
  } finally {
    try {
      rmSync(temporaryFile, { force: true })
    } catch {}
  }
}

function releaseKeyLock(lock: { fd: number; lockFile: string }): void {
  try {
    closeSync(lock.fd)
  } catch {}
  try {
    unlinkSync(lock.lockFile)
  } catch {}
}

export function loadOrCreateMockServerKeyPair(
  keyFile: string | undefined,
  logger: KeyWarningLogger = console
): nacl.BoxKeyPair {
  if (!keyFile) {
    return nacl.box.keyPair()
  }
  const existing = readKeyPair(keyFile)
  if (existing.keyPair) {
    return existing.keyPair
  }

  const lock = acquireKeyLock(keyFile)
  if (lock.keyPair) {
    return lock.keyPair
  }
  let selected: nacl.BoxKeyPair
  try {
    const current = readKeyPair(keyFile)
    if (current.keyPair) {
      selected = current.keyPair
    } else {
      logger.warn(
        `[mock] Key file ${keyFile} is ${current.reason} — minting a fresh key; paired devices must re-pair`
      )
      selected = nacl.box.keyPair()
      persistKeyPair(keyFile, selected)
    }
  } finally {
    releaseKeyLock(lock)
  }
  return selected
}
