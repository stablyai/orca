import { listRunningWslDistrosAsync } from '../wsl'
import { filterPathsToWslDistros } from '../wsl-running-path-filter'

/** Every watched WSL transcript shares one running-list read on this cadence, and reuses any
 *  read another caller started within it, so watching never adds a `wsl.exe` per watcher. */
export const WSL_TRANSCRIPT_RUNNING_OBSERVATION_MS = 5_000
/** A newly watched transcript learns its distro's state this soon, not a whole cadence later. */
export const WSL_TRANSCRIPT_FIRST_OBSERVATION_MS = 2_000
type RunningDistrosCallback = (runningDistros: readonly string[]) => Promise<void> | void
type RunningDistrosSubscription = {
  active: boolean
  callback: RunningDistrosCallback
  inFlight: boolean
  pending: string[] | null
}

const subscriptions = new Map<number, RunningDistrosSubscription>()
let nextSubscriptionId = 0
let timer: ReturnType<typeof setTimeout> | null = null
let timerDueAt = 0

function notify(subscription: RunningDistrosSubscription, runningDistros: string[]): void {
  if (!subscription.active) {
    return
  }
  if (subscription.inFlight) {
    subscription.pending = runningDistros
    return
  }
  subscription.inFlight = true
  void (async () => {
    let next: string[] | null = runningDistros
    while (subscription.active && next) {
      subscription.pending = null
      try {
        await subscription.callback(next)
      } catch {
        // Subscriber failures must not stop shared observation.
      }
      next = subscription.pending
    }
    subscription.inFlight = false
  })()
}

async function observe(): Promise<void> {
  timer = null
  if (subscriptions.size === 0) {
    return
  }
  try {
    const runningDistros = await listRunningWslDistrosAsync({
      startedAfter: performance.now() - WSL_TRANSCRIPT_RUNNING_OBSERVATION_MS
    })
    for (const subscription of subscriptions.values()) {
      notify(subscription, runningDistros)
    }
  } catch {
    // Listing failure leaves state unknown; retry without accessing UNC shares.
  } finally {
    armObservation()
  }
}

function armObservation(delayMs = WSL_TRANSCRIPT_RUNNING_OBSERVATION_MS): void {
  if (subscriptions.size === 0) {
    return
  }
  const dueAt = performance.now() + delayMs
  if (timer) {
    if (timerDueAt <= dueAt) {
      return
    }
    clearTimeout(timer)
  }
  timerDueAt = dueAt
  timer = setTimeout(() => void observe(), delayMs)
  timer.unref?.()
}

export function observeWslTranscriptRunningState(
  path: string,
  onRunning: () => Promise<void> | void,
  onStopped: () => Promise<void> | void
): () => void {
  return observeRunningWslDistros((runningDistros) =>
    filterPathsToWslDistros([path], runningDistros).length > 0 ? onRunning() : onStopped()
  )
}

export function observeRunningWslDistros(callback: RunningDistrosCallback): () => void {
  const id = ++nextSubscriptionId
  const subscription: RunningDistrosSubscription = {
    active: true,
    callback,
    inFlight: false,
    pending: null
  }
  subscriptions.set(id, subscription)
  armObservation(WSL_TRANSCRIPT_FIRST_OBSERVATION_MS)
  return () => {
    subscription.active = false
    subscription.pending = null
    subscriptions.delete(id)
    if (subscriptions.size === 0 && timer) {
      clearTimeout(timer)
      timer = null
    }
  }
}

export function resetWslTranscriptRunningObserverForTests(): void {
  for (const subscription of subscriptions.values()) {
    subscription.active = false
    subscription.pending = null
  }
  subscriptions.clear()
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  nextSubscriptionId = 0
}
