import type { Dirent } from 'node:fs'
import { basename, extname } from 'node:path'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'
import { wslGatedReaddir } from './wsl-transcript-fs-access'

type ScanWaiter = {
  sessionId: string
  resolve: (paths: string[]) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type ScanGeneration = {
  root: string
  controller: AbortController
  sessionIdRefCounts: Map<string, number>
  waiters: Set<ScanWaiter>
  settled: boolean
}

const inFlightScans = new Map<string, ScanGeneration>()

function readDirectory(dirPath: string, signal: AbortSignal): Promise<Dirent[]> {
  return wslGatedReaddir(dirPath, 'scan', signal)
}

function sessionFileName(path: string): string {
  return basename(path, extname(path))
}

function nameMatchesSessionId(name: string, sessionId: string): boolean {
  return name === sessionId || name.endsWith(`-${sessionId}`)
}

function matchesRequestedSession(path: string, sessionIds: Map<string, number>): boolean {
  const name = sessionFileName(path)
  for (const sessionId of sessionIds.keys()) {
    if (nameMatchesSessionId(name, sessionId)) {
      return true
    }
  }
  return false
}

function createScan(root: string): ScanGeneration {
  const scan: ScanGeneration = {
    root,
    controller: new AbortController(),
    sessionIdRefCounts: new Map(),
    waiters: new Set(),
    settled: false
  }
  inFlightScans.set(root, scan)
  return scan
}

function clearScan(scan: ScanGeneration): void {
  if (inFlightScans.get(scan.root) === scan) {
    inFlightScans.delete(scan.root)
  }
}

function removeWaiter(scan: ScanGeneration, waiter: ScanWaiter): boolean {
  if (!scan.waiters.delete(waiter)) {
    return false
  }
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener('abort', waiter.onAbort)
  }
  const count = scan.sessionIdRefCounts.get(waiter.sessionId)
  if (count === 1) {
    scan.sessionIdRefCounts.delete(waiter.sessionId)
  } else if (count) {
    scan.sessionIdRefCounts.set(waiter.sessionId, count - 1)
  }
  return true
}

function settleScan(scan: ScanGeneration, outcome: { paths: string[] } | { error: unknown }): void {
  if (scan.settled) {
    return
  }
  scan.settled = true
  clearScan(scan)
  for (const waiter of scan.waiters) {
    removeWaiter(scan, waiter)
    if ('paths' in outcome) {
      waiter.resolve(outcome.paths)
    } else {
      waiter.reject(outcome.error)
    }
  }
}

function startScan(scan: ScanGeneration): void {
  try {
    const promise = walkSessionFiles(scan.root, 'codex', [], {
      extensions: new Set(['.jsonl']),
      filePredicate: (path) => matchesRequestedSession(path, scan.sessionIdRefCounts),
      readDirectory: (dirPath) => readDirectory(dirPath, scan.controller.signal),
      signal: scan.controller.signal
    })
    void promise.then(
      (paths) => settleScan(scan, { paths }),
      (error: unknown) => settleScan(scan, { error })
    )
  } catch (error) {
    settleScan(scan, { error })
  }
}

function waitForScan(
  scan: ScanGeneration,
  sessionId: string,
  signal?: AbortSignal
): Promise<string[]> {
  signal?.throwIfAborted()
  return new Promise<string[]>((resolve, reject) => {
    const waiter: ScanWaiter = { sessionId, resolve, reject, signal }
    scan.waiters.add(waiter)
    scan.sessionIdRefCounts.set(sessionId, (scan.sessionIdRefCounts.get(sessionId) ?? 0) + 1)
    if (!signal) {
      return
    }
    waiter.onAbort = () => {
      if (!removeWaiter(scan, waiter)) {
        return
      }
      reject(signal.reason ?? new Error('Codex session scan aborted'))
      if (!scan.settled && scan.waiters.size === 0) {
        scan.settled = true
        clearScan(scan)
        scan.controller.abort()
      }
    }
    signal.addEventListener('abort', waiter.onAbort, { once: true })
    if (signal.aborted) {
      waiter.onAbort()
    }
  })
}

async function scanRoot(
  root: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<{ paths: string[]; joined: boolean }> {
  signal?.throwIfAborted()
  const existing = inFlightScans.get(root)
  const scan = existing ?? createScan(root)
  const pending = waitForScan(scan, sessionId, signal)
  if (!existing) {
    startScan(scan)
  }
  return { paths: await pending, joined: Boolean(existing) }
}

function findSessionPath(paths: string[], sessionId: string): string | null {
  return paths.find((path) => nameMatchesSessionId(sessionFileName(path), sessionId)) ?? null
}

/** Share tree discovery, then refresh a shared miss for post-start file creation. */
export async function findWslCodexSessionPath(
  root: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const first = await scanRoot(root, sessionId, signal)
  const firstHit = findSessionPath(first.paths, sessionId)
  if (firstHit || !first.joined) {
    return firstHit
  }
  const refreshed = await scanRoot(root, sessionId, signal)
  return findSessionPath(refreshed.paths, sessionId)
}
