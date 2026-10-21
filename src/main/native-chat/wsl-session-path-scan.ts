import type { Dirent } from 'node:fs'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'
import { SESSION_FILE_ID_LAYOUTS, type SessionIdLookupAgent } from './session-file-id-layouts'
import { wslGatedReaddir } from './wsl-transcript-fs-access'

type ScanWaiter = {
  sessionId: string
  resolve: (paths: string[]) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type ScanGeneration = {
  key: string
  agent: SessionIdLookupAgent
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

function matchesRequestedSession(scan: ScanGeneration, path: string): boolean {
  const { fileMatchesId } = SESSION_FILE_ID_LAYOUTS[scan.agent]
  for (const sessionId of scan.sessionIdRefCounts.keys()) {
    if (fileMatchesId(path, sessionId)) {
      return true
    }
  }
  return false
}

function createScan(key: string, agent: SessionIdLookupAgent, root: string): ScanGeneration {
  const scan: ScanGeneration = {
    key,
    agent,
    root,
    controller: new AbortController(),
    sessionIdRefCounts: new Map(),
    waiters: new Set(),
    settled: false
  }
  inFlightScans.set(key, scan)
  return scan
}

function clearScan(scan: ScanGeneration): void {
  if (inFlightScans.get(scan.key) === scan) {
    inFlightScans.delete(scan.key)
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
    const { directoryPredicate } = SESSION_FILE_ID_LAYOUTS[scan.agent]
    const wanted = (id: string): boolean => scan.sessionIdRefCounts.has(id)
    const promise = walkSessionFiles(scan.root, scan.agent, [], {
      extensions: new Set(['.jsonl']),
      filePredicate: (path) => matchesRequestedSession(scan, path),
      directoryPredicate: directoryPredicate
        ? (name, depth) => directoryPredicate(name, depth, wanted)
        : undefined,
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
      reject(signal.reason ?? new Error('WSL session scan aborted'))
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
  agent: SessionIdLookupAgent,
  root: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<{ paths: string[]; joined: boolean }> {
  signal?.throwIfAborted()
  const key = `${agent}\0${root}`
  const existing = inFlightScans.get(key)
  const scan = existing ?? createScan(key, agent, root)
  const pending = waitForScan(scan, sessionId, signal)
  if (!existing) {
    startScan(scan)
  }
  return { paths: await pending, joined: Boolean(existing) }
}

function findSessionPath(
  agent: SessionIdLookupAgent,
  paths: string[],
  sessionId: string
): string | null {
  const { fileMatchesId } = SESSION_FILE_ID_LAYOUTS[agent]
  return paths.find((path) => fileMatchesId(path, sessionId)) ?? null
}

/**
 * Find one session's transcript under a `\\wsl.localhost` root. Concurrent lookups
 * share one tree walk per root; a shared miss is refreshed for post-start file creation.
 */
export async function findWslSessionPath(
  agent: SessionIdLookupAgent,
  root: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<string | null> {
  const first = await scanRoot(agent, root, sessionId, signal)
  const firstHit = findSessionPath(agent, first.paths, sessionId)
  if (firstHit || !first.joined) {
    return firstHit
  }
  const refreshed = await scanRoot(agent, root, sessionId, signal)
  return findSessionPath(agent, refreshed.paths, sessionId)
}
