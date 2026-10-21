import type { WebContents } from 'electron'
import { abortWhenRendererGone } from './renderer-lifetime-abort'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'

export function captureWatcherSenderLifetime(
  sender: WebContents,
  cleanup: () => void
): AbortSignal {
  const existing = watcherLifecycleState.senderLifetimes.get(sender.id)
  if (existing) {
    return existing.signal
  }
  if (sender.isDestroyed()) {
    return AbortSignal.abort()
  }
  const lifetime = abortWhenRendererGone(sender)
  watcherLifecycleState.senderLifetimes.set(sender.id, lifetime)
  lifetime.signal.addEventListener(
    'abort',
    () => {
      lifetime.dispose()
      watcherLifecycleState.senderLifetimes.delete(sender.id)
      cleanup()
    },
    { once: true }
  )
  return lifetime.signal
}

export function isCurrentWatcherSender(sender: WebContents, signal: AbortSignal): boolean {
  return (
    !sender.isDestroyed() &&
    !signal.aborted &&
    watcherLifecycleState.senderLifetimes.get(sender.id)?.signal === signal
  )
}
