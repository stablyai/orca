import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  parseWorkerWatchdogRequest,
  type WorkerWatchdogRequest,
  type WorkerWatchdogSentinel
} from './worker-watchdog-protocol'

export function writeWorkerWatchdogSentinelAtomically(
  path: string,
  sentinel: WorkerWatchdogSentinel
): void {
  const temporaryPath = `${path}.tmp-${process.pid}`
  const fd = openSync(temporaryPath, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(sentinel)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporaryPath, path)
  try {
    const directoryFd = openSync(dirname(path), 'r')
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
  } catch {
    // Windows cannot open directories for fsync. The file itself is already
    // fsynced and atomically renamed, so directory durability is best-effort.
  }
}

export function readWorkerWatchdogRequestFile(path: string): WorkerWatchdogRequest {
  try {
    return parseWorkerWatchdogRequest(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } finally {
    try {
      unlinkSync(path)
    } catch {
      // The request is single-use; absence after a raced cleanup is acceptable.
    }
  }
}
