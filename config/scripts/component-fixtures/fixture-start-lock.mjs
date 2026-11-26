// Start lock for the detached fixture server. It lists its owner processes, and it is
// reclaimed only after all of them have exited, so a live owner never loses custody.
import {
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import os from 'node:os'
import { serverLockPath } from './fixture-paths.mjs'

// An owner writes its record right after creating the file, so a blank lock is a crash.
const UNREADABLE_LOCK_MS = 10_000

function readLock(fileOrFd = serverLockPath) {
  try {
    return JSON.parse(readFileSync(fileOrFd, 'utf8'))
  } catch {
    return null
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function isAbandoned(lock, mtimeMs) {
  // Why boot time: pids restart after a reboot, so owners of an older lock cannot be alive.
  if (mtimeMs < Date.now() - os.uptime() * 1000) {
    return true
  }
  if (!Array.isArray(lock?.pids)) {
    return Date.now() - mtimeMs > UNREADABLE_LOCK_MS
  }
  return !lock.pids.some(isProcessAlive)
}

function reclaimAbandonedLock() {
  let judged
  try {
    judged = statSync(serverLockPath)
  } catch {
    return true
  }
  if (!isAbandoned(readLock(), judged.mtimeMs)) {
    return false
  }
  // Why rename: it moves exactly one file, so a lock created after the check is put back.
  const moved = `${serverLockPath}.${process.pid}.abandoned`
  try {
    renameSync(serverLockPath, moved)
  } catch {
    return true
  }
  const fd = openSync(moved, 'r')
  const { dev, ino } = fstatSync(fd)
  closeSync(fd)
  if (dev !== judged.dev || ino !== judged.ino) {
    try {
      linkSync(moved, serverLockPath)
    } catch {}
  }
  unlinkSync(moved)
  return true
}

/** Creates the lock owned by this process, reclaiming it only if its owners have all exited. */
export function tryAcquireStartLock(token) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd
    try {
      fd = openSync(serverLockPath, 'wx')
    } catch (error) {
      if (error?.code !== 'EEXIST' || !reclaimAbandonedLock()) {
        return false
      }
      continue
    }
    try {
      writeSync(fd, JSON.stringify({ token, pids: [process.pid] }))
    } finally {
      closeSync(fd)
    }
    return true
  }
  return false
}

/** Adds a spawned server as an owner, so the lock outlives the launcher until it starts. */
export function addStartLockOwner(token, pid) {
  let fd
  try {
    // Why r+: never recreate a lock that the server has already released.
    fd = openSync(serverLockPath, 'r+')
  } catch {
    return
  }
  try {
    const lock = readLock(fd)
    if (lock?.token === token && Array.isArray(lock.pids)) {
      // The record only grows, so overwriting from the start leaves no stale tail.
      writeSync(fd, JSON.stringify({ token, pids: [...lock.pids, pid] }), 0)
    }
  } finally {
    closeSync(fd)
  }
}

// Why removing by name is safe: the caller is a live owner, and a lock with a live owner is
// never reclaimed, so the file read here is still the caller's when it is unlinked.
export function releaseStartLock(token) {
  if (token && readLock()?.token === token) {
    try {
      unlinkSync(serverLockPath)
    } catch {}
  }
}

export function startLockOwners() {
  return readLock()?.pids ?? []
}
