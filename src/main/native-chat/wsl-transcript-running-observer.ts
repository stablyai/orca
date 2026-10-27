import { listRunningWslDistrosAsync } from '../wsl'
import { filterPathsToWslDistros } from '../wsl-running-path-filter'

const OBSERVATION_INTERVAL_MS = 2_000
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
    const runningDistros = await listRunningWslDistrosAsync()
    for (const subscription of subscriptions.values()) {
      notify(subscription, runningDistros)
    }
  } catch {
    // Listing failure leaves state unknown; retry without accessing UNC shares.
  } finally {
    armObservation()
  }
}

function armObservation(): void {
  if (timer || subscriptions.size === 0) {
    return
  }
  timer = setTimeout(() => void observe(), OBSERVATION_INTERVAL_MS)
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
  armObservation()
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
