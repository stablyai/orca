import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export type SafetySnapshotEntry = {
  directory: boolean
  signature: string
}

export type SafetySnapshot = Map<string, SafetySnapshotEntry>
export type SafetyScanResult =
  | { kind: 'complete'; snapshot: SafetySnapshot }
  | { kind: 'cancelled' | 'entry-limit' | 'time-limit' | 'resource-limit' | 'io-error' }
export type SafetyScanOptions = {
  signal?: AbortSignal
  maxEntries?: number
  maxDurationMs?: number
  maxResourceWaitMs?: number
  now?: () => number
  fileSystem?: SafetyFileSystem
}
export type SafetyFileSystem = {
  lstat(path: string): Promise<Stats>
  readdir(path: string): Promise<readonly Dirent[]>
}
export type BoundedFileSystemResult<T> =
  | { kind: 'complete'; value: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'cancelled' }
  | { kind: 'resource-limit' }
  | { kind: 'time-limit' }

const MAX_CONCURRENT_SCANS = 2
const MAX_PHYSICAL_FILE_SYSTEM_OPERATIONS = 8
const DEFAULT_MAX_SCAN_ENTRIES = 100_000
const DEFAULT_MAX_SCAN_DURATION_MS = 10_000

type PermitWaiter = {
  signal?: AbortSignal
  resolve: (release: (() => void) | null) => void
  onAbort: () => void
}

class FairPermitPool {
  private available: number
  private readonly waiters: PermitWaiter[] = []

  constructor(capacity: number) {
    this.available = capacity
  }

  acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    if (signal?.aborted) {
      return Promise.resolve(null)
    }
    if (this.available > 0 && this.waiters.length === 0) {
      this.available -= 1
      return Promise.resolve(this.createRelease())
    }
    return new Promise((resolve) => {
      const waiter: PermitWaiter = {
        signal,
        resolve,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter)
          if (index !== -1) {
            this.waiters.splice(index, 1)
          }
          resolve(null)
        }
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
    })
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift() as PermitWaiter
        waiter.signal?.removeEventListener('abort', waiter.onAbort)
        if (!waiter.signal?.aborted) {
          waiter.resolve(this.createRelease())
          return
        }
      }
      this.available += 1
    }
  }
}

let scanPermits = new FairPermitPool(MAX_CONCURRENT_SCANS)
let physicalFileSystemPermits = new FairPermitPool(MAX_PHYSICAL_FILE_SYSTEM_OPERATIONS)

export function resetWatcherHostFileSystemPermitsForTest(): void {
  scanPermits = new FairPermitPool(MAX_CONCURRENT_SCANS)
  physicalFileSystemPermits = new FairPermitPool(MAX_PHYSICAL_FILE_SYSTEM_OPERATIONS)
}

export const defaultSafetyFileSystem: SafetyFileSystem = {
  lstat,
  readdir: (path) => readdir(path, { withFileTypes: true })
}

export function fileSystemErrorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

// Why: unreadable entries are invisible to every engine (native watches and
// snapshot scans alike), so treating them as absent keeps a worktree with one
// root-owned subtree watchable instead of failing the whole subscription.
export function isInvisibleFileSystemError(error: unknown): boolean {
  const code = fileSystemErrorCode(error)
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM'
}

export function createSafetySnapshotEntry(stats: Stats): SafetySnapshotEntry {
  const directory = stats.isDirectory()
  return {
    directory,
    // Directory content changes must not look like missed events; inode changes
    // still reveal delete/recreate races that invalidate recursive watches.
    signature: directory
      ? `d:${stats.dev}:${stats.ino}`
      : `f:${stats.mode}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`
  }
}

export function boundedFileSystemOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number,
  now: () => number
): Promise<BoundedFileSystemResult<T>> {
  if (signal?.aborted) {
    return Promise.resolve({ kind: 'cancelled' })
  }
  const remaining = deadline - now()
  if (remaining <= 0) {
    return Promise.resolve({ kind: 'time-limit' })
  }
  return acquirePhysicalPermit(signal, remaining).then((admission) => {
    if (admission === 'cancelled') {
      return { kind: 'cancelled' }
    }
    if (admission === 'resource-limit') {
      return { kind: 'resource-limit' }
    }
    const afterAdmission = deadline - now()
    if (afterAdmission <= 0) {
      admission()
      return { kind: 'time-limit' }
    }
    const physicalOperation = Promise.resolve().then(operation)
    void physicalOperation.then(admission, admission)
    return settleLogicalFileSystemOperation(physicalOperation, signal, afterAdmission)
  })
}

function acquirePhysicalPermit(
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<(() => void) | 'cancelled' | 'resource-limit'> {
  const waiting = new AbortController()
  const onAbort = (): void => waiting.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => waiting.abort(), timeoutMs)
  timer.unref?.()
  return physicalFileSystemPermits.acquire(waiting.signal).then((release) => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (release && signal?.aborted) {
      release()
      return 'cancelled'
    }
    if (release) {
      return release
    }
    return signal?.aborted ? 'cancelled' : 'resource-limit'
  })
}

function settleLogicalFileSystemOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<BoundedFileSystemResult<T>> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: BoundedFileSystemResult<T>): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => finish({ kind: 'cancelled' })
    const timer = setTimeout(() => finish({ kind: 'time-limit' }), timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => finish({ kind: 'complete', value }),
      (error: unknown) => finish({ kind: 'error', error })
    )
  })
}

export async function scanWatcherSafetySnapshot(
  root: string,
  ignoreDirs: ReadonlySet<string>,
  options: SafetyScanOptions = {}
): Promise<SafetyScanResult> {
  const now = options.now ?? Date.now
  const release = await scanPermits.acquire(options.signal)
  if (!release) {
    return { kind: 'cancelled' }
  }
  if (options.signal?.aborted) {
    release()
    return { kind: 'cancelled' }
  }
  try {
    return await scanWithLimits(root, ignoreDirs, options, now)
  } finally {
    release()
  }
}

async function scanWithLimits(
  root: string,
  ignoreDirs: ReadonlySet<string>,
  options: SafetyScanOptions,
  now: () => number
): Promise<SafetyScanResult> {
  const snapshot: SafetySnapshot = new Map()
  const pending = [root]
  const deadline = now() + (options.maxDurationMs ?? DEFAULT_MAX_SCAN_DURATION_MS)
  const fileSystem = options.fileSystem ?? defaultSafetyFileSystem
  while (pending.length > 0) {
    if (options.signal?.aborted) {
      return { kind: 'cancelled' }
    }
    if (snapshot.size >= (options.maxEntries ?? DEFAULT_MAX_SCAN_ENTRIES)) {
      return { kind: 'entry-limit' }
    }
    if (now() >= deadline) {
      return { kind: 'time-limit' }
    }
    const current = pending.pop() as string
    const statResult = await boundedFileSystemOperation(
      () => fileSystem.lstat(current),
      options.signal,
      deadline,
      now
    )
    if (
      statResult.kind === 'cancelled' ||
      statResult.kind === 'time-limit' ||
      statResult.kind === 'resource-limit'
    ) {
      return statResult
    }
    if (statResult.kind === 'error') {
      if (isInvisibleFileSystemError(statResult.error)) {
        continue
      }
      return { kind: 'io-error' }
    }
    snapshot.set(current, createSafetySnapshotEntry(statResult.value))
    if (!statResult.value.isDirectory()) {
      continue
    }
    const readResult = await boundedFileSystemOperation(
      () => fileSystem.readdir(current),
      options.signal,
      deadline,
      now
    )
    if (
      readResult.kind === 'cancelled' ||
      readResult.kind === 'time-limit' ||
      readResult.kind === 'resource-limit'
    ) {
      return readResult
    }
    if (readResult.kind === 'error') {
      if (!isInvisibleFileSystemError(readResult.error)) {
        return { kind: 'io-error' }
      }
      continue
    }
    for (const entry of readResult.value) {
      if (!ignoreDirs.has(entry.name)) {
        pending.push(join(current, entry.name))
      }
    }
  }
  return { kind: 'complete', snapshot }
}
