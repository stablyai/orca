import type {
  IPtyProvider,
  PtyBackgroundStreamEvent
} from '../../../providers/pty-provider-contract'
import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import { combineUnsubscribes } from './combine-unsubscribes'

export function subscribeDegradedBackground(
  providers: readonly IPtyProvider[],
  callback: (payload: PtyBackgroundStreamEvent) => void
): () => void {
  return combineUnsubscribes(
    providers.flatMap((provider) => provider.onBackgroundStreamEvent?.(callback) ?? [])
  )
}
export function subscribeDegradedWriteUnavailable(
  adapters: readonly DaemonPtyAdapter[],
  callback: (payload: { id: string }) => void
): () => void {
  return combineUnsubscribes(adapters.map((adapter) => adapter.onWriteUnavailable(callback)))
}
export function subscribeDegradedReplay(
  providers: readonly IPtyProvider[],
  tracked: (() => void)[],
  callback: (payload: { id: string; data: string }) => void
): () => void {
  const unsubscribes = providers.map((provider) => provider.onReplay(callback))
  let active = true
  const trackedUnsubscribe = (): void => {
    if (!active) {
      return
    }
    active = false
    const idx = tracked.indexOf(trackedUnsubscribe)
    if (idx !== -1) {
      tracked.splice(idx, 1)
    }
    combineUnsubscribes(unsubscribes)()
  }
  tracked.push(trackedUnsubscribe)
  return trackedUnsubscribe
}

export function fanoutDegradedSyntheticExits(
  ids: readonly string[],
  forgetRoute: (id: string) => void,
  listeners: Parameters<IPtyProvider['onExit']>[0][],
  code: number,
  exit: { replacedByRestart?: true }
): void {
  for (const id of ids) {
    forgetRoute(id)
    // Listeners may unsubscribe during delivery.
    for (const listener of Array.from(listeners)) {
      listener({ id, code, ...exit })
    }
  }
}

export function subscribeDegradedListener<T>(
  listeners: ((payload: T) => void)[],
  callback: (payload: T) => void
): () => void {
  listeners.push(callback)
  return () => {
    const index = listeners.indexOf(callback)
    if (index !== -1) {
      listeners.splice(index, 1)
    }
  }
}
