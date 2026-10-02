import type { LaunchedAgentForeground } from './launched-agent-foreground'

/**
 * Same vocabulary as a worker's turn start: `unobserved` is unverifiable, never "not delivered";
 * `unsupported` is a launch proven only by its agent holding the terminal; `exited` is a launch the
 * host proved ended before any turn.
 */
export type LaunchTurnStartVerdict =
  | 'observed'
  | 'permission'
  | 'unsupported'
  | 'unobserved'
  | 'exited'

/** How long a launch may go with no hook event at all before its hooks are taken as not reaching it. */
export const LAUNCH_HOOK_SILENCE_MS = 10_000
const LAUNCH_EVIDENCE_POLL_MS = 250
/** A foreground read is a process scan, so it is taken at most this often. */
const LAUNCH_FOREGROUND_READ_MS = 1_000

export type LaunchTurnStartProbe = {
  /** The agent's own hook proof of a prompt-carrying turn; absent where hooks cannot prove one. */
  observeHookTurn?: (signal: AbortSignal) => Promise<'observed' | 'permission' | 'unobserved'>
  /** Any hook event has reached the pane since the launch. */
  hookReachedPane: () => boolean
  /** The pane's title/lifecycle turn-start count: the evidence main accepted. */
  readWorkingSequence: () => number
  /** Whether a startup dialog is on the pane's screen now; read directly, so it needs no quiet. */
  dialogOnScreen: () => boolean
  /** Whether the launch command is still recorded on its PTY; the shell's command-finished retires it. */
  launchRecorded: () => boolean
  readForeground: () => Promise<LaunchedAgentForeground>
}

/**
 * Whether a prompt that rode an agent's launch command started a turn.
 *
 * The agent's hook is the proof wherever it can give one. A launch whose hooks never reach the pane
 * (turned off, or not installed on that host) is judged as main judged it: a title turn-start edge,
 * or else the agent holding its terminal with no startup dialog on screen, since it carries the
 * prompt on its command line. A launch the shell reports finished, with no agent in front, exited at
 * startup.
 */
export async function observeLaunchTurnStart(
  probe: LaunchTurnStartProbe,
  args: { launchStartedAt: number; timeoutMs: number; signal?: AbortSignal }
): Promise<LaunchTurnStartVerdict> {
  const stop = new AbortController()
  const abort = (): void => stop.abort()
  args.signal?.addEventListener('abort', abort, { once: true })
  const deadline = Date.now() + args.timeoutMs
  // Why: the window ends every watch, so a hook proof that never resolves cannot hold the start.
  const expiry = setTimeout(abort, args.timeoutMs)
  try {
    const hook = probe
      .observeHookTurn?.(stop.signal)
      .then((verdict) => (verdict === 'unobserved' ? null : verdict))
      .catch(() => null)
    const launch = watchLaunchEvidence(probe, args.launchStartedAt, deadline, stop.signal)
    return (await firstNonNull(hook ? [hook, launch] : [launch])) ?? 'unobserved'
  } finally {
    clearTimeout(expiry)
    stop.abort()
    args.signal?.removeEventListener('abort', abort)
  }
}

async function watchLaunchEvidence(
  probe: LaunchTurnStartProbe,
  launchStartedAt: number,
  deadline: number,
  signal: AbortSignal
): Promise<LaunchTurnStartVerdict | null> {
  try {
    const baseline = probe.readWorkingSequence()
    let launchSeen = false
    let nextForegroundReadAt = 0
    while (!signal.aborted && Date.now() < deadline) {
      if (probe.launchRecorded()) {
        launchSeen = true
      } else if (launchSeen && (await probe.readForeground()) !== 'agent') {
        return 'exited'
      }
      const hooksSilent =
        !probe.observeHookTurn ||
        (Date.now() - launchStartedAt >= LAUNCH_HOOK_SILENCE_MS && !probe.hookReachedPane())
      if (hooksSilent) {
        if (probe.readWorkingSequence() > baseline) {
          return 'observed'
        }
        if (Date.now() >= nextForegroundReadAt) {
          nextForegroundReadAt = Date.now() + LAUNCH_FOREGROUND_READ_MS
          // A dialog on screen holds the agent; the caller's dialog watch reports it.
          if ((await probe.readForeground()) === 'agent' && !probe.dialogOnScreen()) {
            return 'unsupported'
          }
        }
      }
      await abortableDelay(LAUNCH_EVIDENCE_POLL_MS, signal)
    }
  } catch {
    // A replaced or closed PTY leaves the launch unproven, not failed.
  }
  return null
}

/** The first result that is not null, or null once every promise has settled without one. */
function firstNonNull<T>(promises: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = promises.length
    for (const promise of promises) {
      void promise.then((value) => {
        pending--
        if (value !== null) {
          resolve(value)
        } else if (pending === 0) {
          resolve(null)
        }
      })
    }
  })
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
