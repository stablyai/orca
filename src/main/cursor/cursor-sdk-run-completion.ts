import type { CursorSdkRunMessage } from './cursor-sdk-run-events'

const TERMINAL_RUN_STATUSES = new Set(['finished', 'error', 'cancelled', 'expired'])
const STORE_POLL_MS = 200
const STORE_RESULT_GRACE_MS = 400

export type CursorSdkRunResult = {
  status: string
  result?: string
  error?: { message: string }
  durationMs?: number
}

export type CursorSdkStoredRun = {
  runId?: string
  status: string
  result?: string | null
  error?: string | null
  createdAt?: number | null
  startedAt?: number | null
  endedAt?: number | null
}

export type CursorSdkLiveRun = {
  readonly status: string
  readonly result?: string
  readonly error?: { message: string }
  readonly durationMs?: number
  stream(): AsyncIterable<CursorSdkRunMessage>
  wait(): Promise<CursorSdkRunResult>
  onDidChangeStatus(listener: (status: string) => void): () => void
}

/** JSONL records `finished` while the live stream and `wait()` stay on `running`. */
export async function readCursorSdkRunUntilSettled(
  run: CursorSdkLiveRun,
  onMessage: (message: CursorSdkRunMessage) => void,
  readStoredRun?: () => Promise<CursorSdkStoredRun | null>
): Promise<CursorSdkRunResult> {
  let markSettled: () => void = () => {}
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve
  })
  const unsubscribe = run.onDidChangeStatus((status) => {
    if (isTerminalRunStatus(status)) {
      markSettled()
    }
  })
  if (isTerminalRunStatus(run.status)) {
    markSettled()
  }
  let stopWatchingStore = false
  let finishStored: (stored: CursorSdkStoredRun | null) => void = () => {}
  const stored = new Promise<CursorSdkStoredRun | null>((resolve) => {
    finishStored = resolve
  })
  if (readStoredRun) {
    void watchStoredRun(readStoredRun, () => stopWatchingStore, finishStored)
  }
  const iterator = run.stream()[Symbol.asyncIterator]()
  const reading = (async () => {
    try {
      while (true) {
        const step = await iterator.next()
        if (step.done) {
          return
        }
        onMessage(step.value)
      }
    } catch {
      // Closing the stream rejects the read that is still waiting on it.
    }
  })()
  try {
    const outcome = await Promise.race(
      settledRacers(reading, settled, readStoredRun ? stored : null)
    )
    if (outcome.kind === 'store' && outcome.row && isTerminalRunStatus(outcome.row.status)) {
      await delay(STORE_RESULT_GRACE_MS)
      return cursorSdkRunResultFromStored(outcome.row)
    }
    if (isTerminalRunStatus(run.status)) {
      const deadline = Date.now() + 300
      while (!run.result && run.status === 'finished' && Date.now() < deadline) {
        await delay(20)
      }
      return snapshotSettledRun(run)
    }
    return await run.wait()
  } finally {
    stopWatchingStore = true
    finishStored(null)
    unsubscribe()
    // The JSONL stream's close waits on the same poll that never sees `finished`.
    await Promise.race([Promise.resolve(iterator.return?.()).catch(() => {}), delay(50)])
  }
}

function settledRacers(
  reading: Promise<void>,
  settled: Promise<void>,
  stored: Promise<CursorSdkStoredRun | null> | null
): Promise<
  { kind: 'stream' } | { kind: 'status' } | { kind: 'store'; row: CursorSdkStoredRun | null }
>[] {
  const racers: Promise<
    { kind: 'stream' } | { kind: 'status' } | { kind: 'store'; row: CursorSdkStoredRun | null }
  >[] = [reading.then(() => ({ kind: 'stream' })), settled.then(() => ({ kind: 'status' }))]
  if (stored) {
    racers.push(stored.then((row) => ({ kind: 'store', row })))
  }
  return racers
}

async function watchStoredRun(
  readStoredRun: () => Promise<CursorSdkStoredRun | null>,
  stopped: () => boolean,
  finish: (stored: CursorSdkStoredRun | null) => void
): Promise<void> {
  while (!stopped()) {
    const row = await readStoredRun().catch(() => null)
    if (stopped()) {
      return
    }
    if (row && isTerminalRunStatus(row.status)) {
      finish(row)
      return
    }
    await delay(STORE_POLL_MS)
  }
}

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status.toLowerCase())
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const STORE_MATCH_SKEW_MS = 2_000

/** The stored row can finish before `Agent.send` returns. `priorRunIds` are the rows from before
 *  the send: a short previous turn can still start within the clock skew. */
export async function waitForStoredCursorRun(
  readRuns: () => Promise<readonly CursorSdkStoredRun[]>,
  sentAt: number,
  stopped: () => boolean,
  priorRunIds: ReadonlySet<string> = new Set()
): Promise<CursorSdkStoredRun | null> {
  while (!stopped()) {
    const rows = await readRuns().catch(() => [])
    if (stopped()) {
      return null
    }
    const match = rows.find((row) => {
      const began = row.startedAt ?? row.createdAt
      return (
        !(row.runId && priorRunIds.has(row.runId)) &&
        typeof began === 'number' &&
        began >= sentAt - STORE_MATCH_SKEW_MS &&
        isTerminalRunStatus(row.status)
      )
    })
    if (match) {
      await delay(STORE_RESULT_GRACE_MS)
      return match
    }
    await delay(STORE_POLL_MS)
  }
  return null
}

export function cursorSdkRunResultFromStored(stored: CursorSdkStoredRun): CursorSdkRunResult {
  const durationMs =
    typeof stored.startedAt === 'number' && typeof stored.endedAt === 'number'
      ? stored.endedAt - stored.startedAt
      : undefined
  return {
    status: stored.status,
    ...(stored.result ? { result: stored.result } : {}),
    ...(stored.error ? { error: { message: stored.error } } : {}),
    ...(durationMs === undefined || durationMs < 0 ? {} : { durationMs })
  }
}

function snapshotSettledRun(run: CursorSdkLiveRun): CursorSdkRunResult {
  return {
    status: run.status,
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(typeof run.durationMs === 'number' ? { durationMs: run.durationMs } : {})
  }
}
