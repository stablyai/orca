import type * as pty from 'node-pty'
import { killConptyNow, terminatePtyJob } from '../../windows/windows-pty-job'

// Bundled ConPTY queries DA1 (or CPR when inheriting the cursor) right after it starts reading
// input, and before relaying any client output. A pane without it never reads keyboard input.
const INPUT_READER_ANNOUNCEMENTS = ['\x1b[c', '\x1b[6n'] as const
// The pseudo-window thread can report window visibility ahead of the announcement.
const WINDOW_VISIBILITY_REPORTS = ['\x1b[1t', '\x1b[2t'] as const

export type ConptyStartupVerdict = 'pending' | 'input-reader' | 'no-input-reader'
export type ConptyStartupOutcome = Exclude<ConptyStartupVerdict, 'pending'> | 'exited' | 'undecided'

// A console shell connects, prompting the announcement, within milliseconds; under heavy CI load
// within ~4s. Past this the pane is handed out unverified rather than stalling the spawn reply.
export const CONPTY_STARTUP_DECISION_LIMIT_MS = 5_000

export const CONPTY_NO_INPUT_READER_NOTICE =
  '\r\n\x1b[31m[Orca] Windows could not start keyboard input for this terminal. Close it and open a new one.\x1b[0m\r\n'

export function classifyConptyStartupOutput(output: string): ConptyStartupVerdict {
  let rest = output
  for (;;) {
    const report = WINDOW_VISIBILITY_REPORTS.find((candidate) => rest.startsWith(candidate))
    if (!report) {
      break
    }
    rest = rest.slice(report.length)
  }
  if (INPUT_READER_ANNOUNCEMENTS.some((announcement) => rest.startsWith(announcement))) {
    return 'input-reader'
  }
  // A chunk can end mid-sequence; only output that rules out every expected prefix decides.
  const expected = [...INPUT_READER_ANNOUNCEMENTS, ...WINDOW_VISIBILITY_REPORTS]
  return expected.some((sequence) => sequence.startsWith(rest)) ? 'pending' : 'no-input-reader'
}

export type ConptyStartupEvents = {
  data: string[]
  exit: { exitCode: number; signal?: number } | null
}

export type ConptyStartupWatch = {
  /** Settles on the first output that decides, or on exit before any did. */
  verdict: Promise<ConptyStartupOutcome>
  /** Hands buffered output and exit to the caller and stops buffering. */
  claim(): ConptyStartupEvents
}

/** Buffers a fresh ConPTY's output until its owner claims it, so no startup byte is lost. */
export function watchConptyStartup(proc: pty.IPty): ConptyStartupWatch {
  const events: ConptyStartupEvents = { data: [], exit: null }
  let output = ''
  let settle: (outcome: ConptyStartupOutcome) => void = () => {}
  const verdict = new Promise<ConptyStartupOutcome>((resolve) => {
    settle = resolve
  })
  let decided = false
  const dataSubscription = proc.onData((data) => {
    events.data.push(data)
    if (decided) {
      return
    }
    output += data
    const classified = classifyConptyStartupOutput(output)
    if (classified !== 'pending') {
      decided = true
      settle(classified)
    }
  })
  const exitSubscription = proc.onExit(({ exitCode, signal }) => {
    events.exit = { exitCode, ...(signal !== undefined ? { signal } : {}) }
    decided = true
    settle('exited')
  })
  return {
    verdict,
    claim: () => {
      dataSubscription.dispose()
      exitSubscription.dispose()
      return events
    }
  }
}

async function decideConptyStartup(
  proc: pty.IPty,
  signal: AbortSignal | undefined
): Promise<{ outcome: ConptyStartupOutcome; claim: () => ConptyStartupEvents }> {
  const watch = watchConptyStartup(proc)
  let limit: ReturnType<typeof setTimeout> | undefined
  let onAbort = (): void => {}
  try {
    signal?.throwIfAborted()
    const outcome = await new Promise<ConptyStartupOutcome>((resolve, reject) => {
      onAbort = () => reject(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      limit = setTimeout(() => resolve('undecided'), CONPTY_STARTUP_DECISION_LIMIT_MS)
      limit.unref?.()
      void watch.verdict.then(resolve)
    })
    return { outcome, claim: watch.claim }
  } catch (error) {
    // A canceled spawn must not leave the half-started shell running.
    discardConpty(proc, watch)
    throw error
  } finally {
    clearTimeout(limit)
    signal?.removeEventListener('abort', onAbort)
  }
}

function discardConpty(proc: pty.IPty, watch: Pick<ConptyStartupWatch, 'claim'>): void {
  watch.claim()
  // Handle-based only: a pid may already be recycled if the shell exited during startup.
  terminatePtyJob(proc)
  killConptyNow(proc)
  proc.kill()
}

// Why process-wide: the announcement is a fact of the bundled ConPTY build. Until one pane shows
// it, a missing one may mean a newer build changed its startup, not that input is dead.
let announcementObserved = false
let announcementUntrusted = false
// Logged with each respawn so a misfiring check shows up as a climbing count in the daemon log.
let respawnCount = 0

/** Test seam: reset the process-wide trust in the announcement. */
export function _resetConptyStartupTrustForTest(): void {
  announcementObserved = false
  announcementUntrusted = false
  respawnCount = 0
}

function withNotice(claim: () => ConptyStartupEvents): () => ConptyStartupEvents {
  return () => {
    const events = claim()
    return { ...events, data: [...events.data, CONPTY_NO_INPUT_READER_NOTICE] }
  }
}

// Verify ConPTY input before exposing the pane, so respawning cannot repeat user input.
export async function spawnConptyWithInputReader(
  spawn: () => Promise<pty.IPty>,
  opts: {
    label: string
    signal?: AbortSignal
    // Only Orca's default interactive argv is safe to respawn; custom argv may repeat a command.
    respawnSafe: boolean
  }
): Promise<{ proc: pty.IPty; claimStartupEvents: () => ConptyStartupEvents }> {
  const first = await spawn()
  if (announcementUntrusted) {
    return { proc: first, claimStartupEvents: () => ({ data: [], exit: null }) }
  }
  const firstStartup = await decideConptyStartup(first, opts.signal)
  if (firstStartup.outcome === 'input-reader') {
    announcementObserved = true
  }
  if (firstStartup.outcome !== 'no-input-reader') {
    return { proc: first, claimStartupEvents: firstStartup.claim }
  }
  if (!opts.respawnSafe) {
    console.warn(`[daemon/pty] ConPTY for "${opts.label}" started without an input reader`)
    const claim = firstStartup.claim
    return { proc: first, claimStartupEvents: announcementObserved ? withNotice(claim) : claim }
  }
  respawnCount += 1
  console.warn(
    `[daemon/pty] ConPTY for "${opts.label}" started without an input reader; respawning (${respawnCount})`
  )
  discardConpty(first, firstStartup)
  const retry = await spawn()
  const retryStartup = await decideConptyStartup(retry, opts.signal)
  if (retryStartup.outcome === 'input-reader') {
    announcementObserved = true
  }
  if (retryStartup.outcome !== 'no-input-reader') {
    return { proc: retry, claimStartupEvents: retryStartup.claim }
  }
  if (!announcementObserved) {
    // Two misses and no pane ever announced: distrust the check rather than respawn every pane.
    announcementUntrusted = true
    console.warn('[daemon/pty] ConPTY never announced an input reader; disabling the startup check')
    return { proc: retry, claimStartupEvents: retryStartup.claim }
  }
  console.warn(`[daemon/pty] ConPTY for "${opts.label}" again started without an input reader`)
  // After one respawn, show the failure on screen instead of silently ignoring keystrokes.
  return { proc: retry, claimStartupEvents: withNotice(retryStartup.claim) }
}
