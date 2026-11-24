// A bot's background run (Look around, Tidy-up): when it may start, its time limit, stopping it
// at that limit, and telling a run the host's sleep cut short from one that failed. The one wake
// gate every scheduled bot run uses:
// - at the tick: `power.settled()`, then `await power.checkFullWake()` once a run is due;
// - at the opening message: `await power.checkFullWake()` again, a fresh reading, inside the
//   start's `beforeFirstMessage`, throwing to defer, and `withoutBackgroundRun` to take the run
//   back with its slot open;
// - while it runs: `watchBackgroundRun(power, sessionId)` from before the start, for the
//   awake-time limit over the start and the turn (`startWithinLimit`), `slept()` and the
//   idle-sleep hold. `systemBackgroundRunPower()` builds the host's power, one per runner.
import type { BotRunSend, BotTurnEnd, BotTurnWatch } from './bot-run-turn-watch'

/** How long a stopped run's turn gets to end before its Stop is asked again. */
export const BACKGROUND_RUN_STOP_GRACE_MS = 10 * 1000

/** Time the host lost during a run past this means it slept (or was stalled) in the run. */
export const BACKGROUND_RUN_SLEPT_MS = 10 * 1000

/** The awake-time limit looks again at least this often, so time asleep never counts toward it. */
const AWAKE_LIMIT_CHECK_MS = 30 * 1000

/** The host's power, as a background run sees it. A scheduled run starts only in full wake: one
 *  started in a dark wake is frozen when the host sleeps again within seconds. */
export type BackgroundRunPower = {
  /** Awake, and two minutes since the last wake. Cheap; read every tick. */
  settled: () => boolean
  /** Settled, and the host reads as in full wake now, not a dark wake, with no power event during
   *  the reading. A fresh reading every call. */
  checkFullWake: () => Promise<boolean>
  /** Suspends the host has reported so far. */
  suspends: () => number
  /** Changes with every reported suspend and resume, so a check made in one stretch of being
   *  awake can be held to it later, synchronously. */
  epoch: () => number
  /** A clock that stands still while the host sleeps. */
  awakeNow: () => number
  wallNow: () => number
  /** Holds off idle sleep until the returned release is called. */
  holdAwake: () => () => void
}

export function withLimit<T>(promise: Promise<T>, ms: number): Promise<T | 'timed_out'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), ms)
  })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

/** One run's view of the host's power, from when it was recorded: the host is held awake until
 *  `releaseHold`, and its sleep is tracked until `end`. */
export type BackgroundRunWatch = {
  /** `promise`, or 'timed_out' once the run has been awake `ms` since it was recorded, setup
   *  included; time asleep does not count. */
  limit: <T>(promise: Promise<T>, ms: number) => Promise<T | 'timed_out'>
  /** The host reported a suspend, or slept or stalled unreported, since the run started. */
  slept: () => boolean
  /** Awake time since the run was recorded. */
  awakeFor: () => number
  /** Lets the host idle-sleep again; sleep is still tracked, through a stop at the limit. */
  releaseHold: () => void
  /** The run is over: tracking ends, a run the host slept in stays known as one, and the hold
   *  goes if it hasn't. */
  end: () => void
}

/** Runs going on now, and the latest that ended after the host slept, by session: their turn
 *  ends before the runner records them, and a turn the host's sleep cut short is no news. */
const liveRuns = new Map<string, BackgroundRunWatch>()
const sleptRuns = new Set<string>()
const SLEPT_RUNS_KEPT = 50

/** The host slept during this background run's session. */
export function backgroundRunSlept(sessionId: string): boolean {
  return sleptRuns.has(sessionId) || liveRuns.get(sessionId)?.slept() === true
}

export function watchBackgroundRun(
  power: BackgroundRunPower,
  sessionId: string
): BackgroundRunWatch {
  const start = { awake: power.awakeNow(), wall: power.wallNow(), suspends: power.suspends() }
  const awakeFor = () => power.awakeNow() - start.awake
  let release: (() => void) | null = power.holdAwake()
  const watch: BackgroundRunWatch = {
    async limit(promise, ms) {
      for (;;) {
        const left = ms - awakeFor()
        if (left <= 0) {
          return 'timed_out'
        }
        // A timer armed before a sleep may fire on waking; the clock decides what is left.
        const ended = await withLimit(promise, Math.min(left, AWAKE_LIMIT_CHECK_MS))
        if (ended !== 'timed_out') {
          return ended
        }
      }
    },
    awakeFor,
    // A reported suspend, however short; without one, a gap only a sleep or stall explains.
    slept: () =>
      power.suspends() > start.suspends ||
      power.wallNow() - start.wall - awakeFor() > BACKGROUND_RUN_SLEPT_MS,
    releaseHold() {
      const held = release
      release = null
      try {
        held?.()
      } catch (error) {
        console.warn('[bots] could not release the awake hold of a background run', error)
      }
    },
    end() {
      watch.releaseHold()
      if (liveRuns.get(sessionId) === watch) {
        liveRuns.delete(sessionId)
        if (watch.slept()) {
          sleptRuns.add(sessionId)
          for (const old of sleptRuns) {
            if (sleptRuns.size <= SLEPT_RUNS_KEPT) {
              break
            }
            sleptRuns.delete(old)
          }
        }
      }
    }
  }
  liveRuns.set(sessionId, watch)
  return watch
}

/** A run's setup, its start and its turn under the one awake-time limit its watch keeps, so a
 *  setup or start that stalls, or one that sent its prompt and then hangs, is bounded too. Past
 *  the limit `timedOut()` is true for good: the start's checks refuse with it, so a late start
 *  sends nothing, and one that returns late has its turn stopped. */
export type RunStart = {
  ended: Promise<BotTurnEnd | 'timed_out'>
  timedOut: () => boolean
  /** The turn's end once the start returned; until then the start itself. */
  turnEnd: () => Promise<unknown>
  /** Lets the turn watch go, now or whenever a late setup brings it. */
  dispose: () => void
}

export function startWithinLimit(
  watch: BackgroundRunWatch,
  run: {
    /** The turn watch the run reads its end from. */
    setup: () => Promise<BotTurnWatch>
    start: () => Promise<BotRunSend>
    /** Stops the run's turn; called when a start returns only after the limit. */
    stopTurn: () => Promise<void>
  },
  ms: number
): RunStart {
  let timedOut = false
  let disposed = false
  let turns: BotTurnWatch | null = null
  let turnEnd: Promise<BotTurnEnd> | null = null
  const ready = run.setup().then((watching) => {
    if (disposed) {
      watching.dispose()
      throw new Error('background_run_over')
    }
    return (turns = watching)
  })
  const sent = ready.then(async (watching) => ({ watching, send: await run.start() }))
  // A start that returns past the limit sent a turn nobody watches any more: stop it.
  sent
    .then(
      () => (timedOut ? run.stopTurn() : undefined),
      () => undefined
    )
    .catch((error: unknown) => console.warn('[bots] could not stop a late background run', error))
  const started = sent.then(({ watching, send }) => (turnEnd = watching.next(send)))
  // A setup or start that fails after the limit has nobody waiting on it.
  started.catch(() => undefined)
  return {
    ended: watch.limit(started, ms).then((ended) => {
      timedOut ||= ended === 'timed_out'
      return ended
    }),
    // The clock itself, not only the timer, which a busy host may run late.
    timedOut: () => timedOut || watch.awakeFor() >= ms,
    turnEnd: () => turnEnd ?? started,
    dispose: () => {
      disposed = true
      turns?.dispose()
    }
  }
}

/** When a run may still reach its agent. Every run is fenced once past its limit or over. A
 *  scheduled one is admitted at its opening message on a fresh full-wake reading, and held to it
 *  synchronously at delivery, after the last await: settled, with no power event since. Refused,
 *  it is deferred, and its runner takes it back with its slot open. */
export type RunGate = {
  attach: (start: RunStart) => void
  finish: () => void
  deferred: () => boolean
  /** Its opening message was let through to delivery: from then on its turn may run. */
  kept: () => boolean
  /** For the start's `beforeFirstMessage`; throws to refuse. */
  beforeFirstMessage: () => Promise<void>
  /** For the start's `beforeDelivery`; false withdraws the opening message. */
  beforeDelivery: () => boolean
  /** After the start returns: throws when delivery was refused, so the run never waits on it. */
  afterStart: () => void
}

export function runGate(
  power: Pick<BackgroundRunPower, 'checkFullWake' | 'settled' | 'epoch'>,
  run: { scheduled: boolean; mayStart: () => boolean }
): RunGate {
  let start: RunStart | undefined
  let finished = false
  let deferred = false
  let withheld = false
  let kept = false
  let admittedIn: number | null = null
  const fenced = (): boolean => finished || start?.timedOut() === true
  const defer = (): never => {
    deferred = true
    throw new Error('background_run_deferred')
  }
  return {
    attach: (attached) => (start = attached),
    finish: () => (finished = true),
    deferred: () => deferred,
    kept: () => kept,
    async beforeFirstMessage() {
      if (fenced()) {
        throw new Error('background_run_over')
      }
      if (run.scheduled) {
        const epoch = power.epoch()
        if (!run.mayStart() || !(await power.checkFullWake()) || !run.mayStart()) {
          defer()
        }
        admittedIn = epoch
      }
      // The full-wake read takes a moment: the limit may have passed in it.
      if (fenced()) {
        throw new Error('background_run_over')
      }
    },
    beforeDelivery() {
      const held =
        !fenced() &&
        (!run.scheduled || (power.settled() && power.epoch() === admittedIn && run.mayStart()))
      withheld ||= !held
      deferred ||= !held && !fenced()
      kept ||= held
      return held
    },
    afterStart() {
      if (withheld) {
        throw new Error('background_run_withheld')
      }
    }
  }
}

/** The run's turn end, or 'timed_out' at its limit once its turn is stopped. The awake hold goes
 *  at the limit; its sleep is still tracked through the stop. */
export async function awaitRunEnd(
  watch: BackgroundRunWatch,
  host: Parameters<typeof stopUntilIdle>[0],
  sessionId: string,
  start: RunStart
): Promise<BotTurnEnd | 'timed_out'> {
  const ended = await start.ended
  watch.releaseHold()
  if (ended === 'timed_out') {
    await stopUntilIdle(host, sessionId, start.turnEnd())
  }
  return ended
}

/** A run that ends on an error after its opening message was let through (its start failed
 *  late, say) may still have a turn running: stop it before the run lets go. */
export async function stopIfKept(
  gate: Pick<RunGate, 'kept'>,
  host: Parameters<typeof stopUntilIdle>[0],
  sessionId: string,
  start: RunStart | undefined
): Promise<void> {
  if (gate.kept()) {
    await stopUntilIdle(host, sessionId, start?.turnEnd() ?? Promise.resolve())
  }
}

/** Only a failed turn notifies; a run that couldn't start, stalled or was cut off never does. */
export function turnFailed(ended: BotTurnEnd | 'timed_out'): boolean {
  return ended !== 'timed_out' && 'outcome' in ended && ended.outcome === 'failure'
}

/** Holds the run's slot until its host runs nothing for it, asking it to stop each grace period. */
export async function stopUntilIdle(
  host: {
    stopTurn: (sessionId: string) => Promise<void>
    turnRunning: (sessionId: string) => boolean
  },
  sessionId: string,
  turnEnd: Promise<unknown>
): Promise<void> {
  const ended = turnEnd.then(
    () => undefined,
    () => undefined
  )
  let stopping: Promise<void> | undefined
  while (host.turnRunning(sessionId)) {
    stopping ??= host
      .stopTurn(sessionId)
      .catch((error: unknown) => console.warn('[bots] could not stop a run at its limit', error))
      .finally(() => (stopping = undefined))
    const woke = await withLimit(Promise.race([ended, stopping]), BACKGROUND_RUN_STOP_GRACE_MS)
    // Woken early but still running: wait out the grace before asking again.
    if (woke !== 'timed_out' && host.turnRunning(sessionId)) {
      await withLimit(new Promise<never>(() => {}), BACKGROUND_RUN_STOP_GRACE_MS)
    }
  }
}
