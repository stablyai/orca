import * as Notifications from 'expo-notifications'
import type { DesktopNotificationSource } from './notification-routing'

// A prompt signal for "an agent finished a turn", used to speak replies without
// waiting for a background-throttled poll.
//
// Why not poll alone: speak-back watches `worktree.ps` on a 4s interval, which
// Android throttles hard under Doze/App Standby — measured 2026-07-21 on the
// Nord, gaps stretched to 62s while backgrounded, so a reply could be spoken a
// minute late.
//
// Why listen to the presented notification rather than the RPC stream: the
// desktop's agent-task-complete push already arrives promptly on the live
// socket and is shown as a local notification. Hooking the notification the app
// ALREADY presents needs no change to the notification module (which sits at
// its max-lines cap) and keeps this feature a rider on that path rather than a
// branch inside it. Same timing, less coupling.
//
// Scope note: this deliberately does nothing when the app is fully closed. The
// operator's call 2026-07-21 -- a swiped-away app should stay silent, which is
// the right boundary on a daily-driver phone and avoids a foreground service.

type AgentCompleteListener = (hostId: string | undefined, worktreeId: string | undefined) => void

const listeners = new Set<AgentCompleteListener>()

function notificationData(
  notification: Notifications.Notification
): { source?: DesktopNotificationSource; hostId?: string; worktreeId?: string } {
  return (notification.request.content.data ?? {}) as {
    source?: DesktopNotificationSource
    hostId?: string
    worktreeId?: string
  }
}

/** Subscribe to agent-turn-complete signals. Returns an unsubscribe function.
 *  The underlying OS listener is attached lazily on the first subscriber and
 *  torn down when the last one leaves, so an app with speak-back disarmed
 *  registers nothing. */
let subscription: Notifications.Subscription | null = null

function dispatch(notification: Notifications.Notification): void {
  const data = notificationData(notification)
  if (data.source !== 'agent-task-complete') {
    return
  }
  // Set iteration tolerates mutation: a listener unsubscribing itself mid-loop
  // is safe, and one that removes a not-yet-visited listener correctly stops
  // that one from being called.
  for (const current of listeners) {
    try {
      current(data.hostId, data.worktreeId)
    } catch {
      // Swallow: one bad listener must not break the others.
    }
  }
}

/** Subscribe to agent-turn-complete signals. Returns an unsubscribe function.
 *  The OS listener is attached on the first subscriber and removed only when
 *  the LAST one leaves, so an app with speak-back disarmed registers nothing
 *  and a departing first subscriber does not deafen the remaining ones. */
export function onAgentTaskComplete(listener: AgentCompleteListener): () => void {
  listeners.add(listener)
  if (subscription === null) {
    subscription = Notifications.addNotificationReceivedListener(dispatch)
  }
  let released = false
  return () => {
    // Guard double-unsubscribe: React can invoke a cleanup twice under strict
    // effects, and a second delete must not tear down a live subscription that
    // other listeners still depend on.
    if (released) {
      return
    }
    released = true
    listeners.delete(listener)
    if (listeners.size === 0) {
      subscription?.remove()
      subscription = null
    }
  }
}
