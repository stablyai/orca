import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { win32 } from 'node:path'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'
import { SUBAGENT_DIR_NAME } from '../ai-vault/session-scanner-subagent-transcripts'
import { runWslTranscriptFsTask } from './wsl-transcript-fs-gate'

type WslSessionScanAgent = 'claude' | 'codex'

type ScanWaiter = {
  sessionId: string
  resolve: (paths: string[]) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type ScanGeneration = {
  key: string
  root: string
  agent: WslSessionScanAgent
  controller: AbortController
  sessionIdRefCounts: Map<string, number>
  waiters: Set<ScanWaiter>
  settled: boolean
}

const inFlightScans = new Map<string, ScanGeneration>()

function readDirectory(dirPath: string, signal: AbortSignal): Promise<Dirent[]> {
  return runWslTranscriptFsTask(
    { operation: 'readdir', path: dirPath, priority: 'scan', signal },
    () => readdir(dirPath, { withFileTypes: true })
  )
}

// Why: WSL scan paths can contain either separator when tests run off Windows.
function sessionFileName(path: string): string {
  return win32.basename(path, win32.extname(path))
}

function nameMatchesSessionId(
  agent: WslSessionScanAgent,
  name: string,
  sessionId: string
): boolean {
  return name === sessionId || (agent === 'codex' && name.endsWith(`-${sessionId}`))
}

function matchesRequestedSession(
  agent: WslSessionScanAgent,
  path: string,
  sessionIds: Map<string, number>
): boolean {
  const name = sessionFileName(path)
  for (const sessionId of sessionIds.keys()) {
    if (nameMatchesSessionId(agent, name, sessionId)) {
      return true
    }
  }
  return false
}

function createScan(agent: WslSessionScanAgent, root: string): ScanGeneration {
  const key = `${agent}:${root}`
  const scan: ScanGeneration = {
    key,
    root,
    agent,
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
    const promise = walkSessionFiles(scan.root, scan.agent, [], {
      extensions: new Set(['.jsonl']),
      filePredicate: (path) => matchesRequestedSession(scan.agent, path, scan.sessionIdRefCounts),
      directoryPredicate: (name) => scan.agent !== 'claude' || name !== SUBAGENT_DIR_NAME,
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
  agent: WslSessionScanAgent,
  root: string,
  sessionId: string,
  signal?: AbortSignal
): Promise<{ paths: string[]; joined: boolean }> {
  signal?.throwIfAborted()
  const key = `${agent}:${root}`
  const existing = inFlightScans.get(key)
  const scan = existing ?? createScan(agent, root)
  const pending = waitForScan(scan, sessionId, signal)
  if (!existing) {
    startScan(scan)
  }
  return { paths: await pending, joined: Boolean(existing) }
}

function findSessionPath(
  agent: WslSessionScanAgent,
  paths: string[],
  sessionId: string
): string | null {
  return paths.find((path) => nameMatchesSessionId(agent, sessionFileName(path), sessionId)) ?? null
}

/** Share WSL tree discovery, then refresh a shared miss for post-start file creation. */
export async function findWslSessionPath(
  agent: WslSessionScanAgent,
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
