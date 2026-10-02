// Reads what tui-idle callers observe off a runtime pane: the ranked verdict and a wait's outcome.
import { afterAll, beforeAll, vi } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import { TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import type { TuiIdleVerdict } from './tui-idle-evidence'

/** The runtime members the probe reads: the verdict every tui-idle waiter settles on, and the
 *  live records whose output clock a restored pane lacks. */
type CensusRuntimeInternals = {
  evaluateTuiIdleForLeaf(leaf: RuntimeLeafRecord): TuiIdleVerdict
  getLiveLeafForHandle(handle: string): { leaf: RuntimeLeafRecord }
  ptysById: Map<string, { lastOutputAt: number | null }>
}

function internalsOf(runtime: OrcaRuntimeService): CensusRuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: protected members of OrcaRuntimeService (orca-runtime-resolve-exit-waiters.ts, orca-runtime-runtime-id.ts); only readClockless writes, and it restores what it clears.
  return runtime as unknown as CensusRuntimeInternals
}

function verdictLabel(verdict: TuiIdleVerdict): string {
  switch (verdict.kind) {
    case 'blocked':
      return `blocked:${verdict.reason}`
    case 'pending':
      return `pending:${verdict.quietForeground}`
    case 'ready-strong':
    case 'ready-weak':
    case 'working':
      return verdict.kind
  }
}

function readVerdict(runtime: OrcaRuntimeService, handle: string): string {
  const internals = internalsOf(runtime)
  return verdictLabel(internals.evaluateTuiIdleForLeaf(internals.getLiveLeafForHandle(handle).leaf))
}

// Why several turns: the poll tick awaits the emulator's write chain, then the foreground probe.
const FLUSH_TURNS = 3

async function flushUntil(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < FLUSH_TURNS && !done(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/**
 * What `terminal wait --for tui-idle` started now returns, and when: `@start` (before any poll
 * tick) or `@poll` (on the first tick, one interval later); `pending` if neither.
 */
async function probeWait(runtime: OrcaRuntimeService, handle: string): Promise<string> {
  const abort = new AbortController()
  let outcome = ''
  let when = '@start'
  const settled = runtime
    .waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 3_600_000, signal: abort.signal })
    .then(
      (result) => {
        const verdict = result.blockedReason
          ? `blocked:${result.blockedReason}`
          : result.satisfied
            ? 'ready'
            : 'unsatisfied'
        outcome = `${verdict}${when}`
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (message !== 'request_aborted') {
          outcome = `error:${message}${when}`
        }
      }
    )
  const isSettled = (): boolean => outcome !== ''
  await flushUntil(isSettled)
  if (!isSettled()) {
    when = '@poll'
    await vi.advanceTimersByTimeAsync(CENSUS_POLL_INTERVAL_MS)
    await flushUntil(isSettled)
  }
  abort.abort()
  await settled
  return outcome || 'pending'
}

/**
 * The same tail and screen as a pane with no output clock (restored or daemon-adopted). Why
 * mutate the live records: the wait re-reads them, so a copy would not reach it.
 */
async function readClockless(runtime: OrcaRuntimeService, handle: string): Promise<string> {
  const internals = internalsOf(runtime)
  const { leaf } = internals.getLiveLeafForHandle(handle)
  const pty = internals.ptysById.get(TRANSCRIPT_PANE_PTY_ID)
  const leafClock = leaf.lastOutputAt
  const ptyClock = pty?.lastOutputAt ?? null
  leaf.lastOutputAt = null
  if (pty) {
    pty.lastOutputAt = null
  }
  try {
    return `verdict=${readVerdict(runtime, handle)} wait=${await probeWait(runtime, handle)}`
  } finally {
    internals.getLiveLeafForHandle(handle).leaf.lastOutputAt = leafClock
    if (pty) {
      pty.lastOutputAt = ptyClock
    }
  }
}

// Why literals, not TUI_IDLE_QUIESCENCE_MS / TUI_IDLE_POLL_INTERVAL_MS: a changed window or poll
// interval must surface as changed verdicts. The edge read sits 1 ms inside today's window.
const CENSUS_QUIET_MS = 3_000
const CENSUS_POLL_INTERVAL_MS = 2_000

/** Writes `chunk` as PTY output at `at`, then lets the runtime finish handling it. */
export async function feedPane(
  runtime: OrcaRuntimeService,
  chunk: string,
  at: number
): Promise<void> {
  vi.setSystemTime(at)
  let painted: Promise<void> = Promise.resolve()
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, at, chunk.length, false, (completion) => {
    painted = completion
  })
  await painted
  // Why a macrotask turn: work chained on the paint lands within a few microtasks, so reading
  // right after it would pin how many awaits the census happens to take. A caller's read is a
  // later event-loop turn.
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Exits the pane's PTY, which disposes its emulator; the runtime itself has no teardown. */
export function closePane(runtime: OrcaRuntimeService): void {
  void runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
}

export type PaneObservation = { clocked: string; clockless: string }

/**
 * After output at `at`: the verdict then (`now`), had the stream stopped 1 ms short of and for
 * the quiescence window (`edge`, `quiet`), and a wait started at that quiet point; then the
 * same pane read clockless.
 */
export async function observePane(
  runtime: OrcaRuntimeService,
  handle: string,
  at: number
): Promise<PaneObservation> {
  const now = readVerdict(runtime, handle)
  vi.setSystemTime(at + CENSUS_QUIET_MS - 1)
  const edge = readVerdict(runtime, handle)
  vi.setSystemTime(at + CENSUS_QUIET_MS)
  const quiet = readVerdict(runtime, handle)
  const wait = await probeWait(runtime, handle)
  return {
    clocked: `now=${now} edge=${edge} quiet=${quiet} wait=${wait}`,
    clockless: await readClockless(runtime, handle)
  }
}

/** Pins the host platform and fakes the clock and the idle poll's interval for a census suite. */
export function useCensusEnvironment(): void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  beforeAll(() => {
    // Why darwin: verdicts must not depend on the CI host. All but one recording (a Cline Windows
    // startup, whose screen carries no platform branch) were captured on POSIX.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    // Why only these: xterm's write queue runs on real setTimeout.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  })
  afterAll(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })
}
