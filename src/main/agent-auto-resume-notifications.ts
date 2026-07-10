import { Notification } from 'electron'
import type { NotificationSettings } from '../shared/types'
import type { AgentAutoResumeNotification } from './agent-auto-resume-service'

// Why: main-originated (not renderer-dispatched) notifications, so they build
// their own Notification the way triggerStartupNotificationRegistration does,
// while still honoring the user's global notifications-enabled switch.
export type AgentAutoResumeNotifierDeps = {
  getNotificationSettings: () => NotificationSettings
  /** Bring Orca forward and focus the affected worktree/pane on click. */
  focus?: (worktreeId: string, paneKey: string | null) => void
  formatTime?: (epochMs: number) => string
  logger?: Pick<Console, 'warn'>
}

function defaultFormatTime(epochMs: number): string {
  try {
    return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return 'the reset time'
  }
}

function buildContent(
  notification: AgentAutoResumeNotification,
  formatTime: (epochMs: number) => string
): { title: string; body: string } {
  const when =
    typeof notification.resumesAt === 'number' && Number.isFinite(notification.resumesAt)
      ? formatTime(notification.resumesAt)
      : null
  if (notification.kind === 'detected') {
    return {
      title: 'Agent rate-limited',
      body: when
        ? `Orca will auto-resume it at ${when}.`
        : 'Orca will auto-resume it when the limit resets.'
    }
  }
  if (notification.kind === 'dead-pty') {
    return {
      title: 'Rate-limited agent exited',
      body: 'The agent process exited while rate-limited. Reopen its worktree to resume the session.'
    }
  }
  return {
    title: 'Auto-resume failed',
    body: "Orca couldn't resume the rate-limited agent. Resume it manually."
  }
}

/**
 * Deliver a native notification for an auto-resume lifecycle event, gated by
 * the global notifications switch. Detection and give-up always notify; a
 * quiet successful resume is intentionally not surfaced here (the CLI shows its
 * own countdown), matching the existing notification-granularity patterns.
 */
export function deliverAgentAutoResumeNotification(
  notification: AgentAutoResumeNotification,
  deps: AgentAutoResumeNotifierDeps
): void {
  if (deps.getNotificationSettings().enabled !== true) {
    return
  }
  if (!Notification.isSupported()) {
    return
  }
  const { title, body } = buildContent(notification, deps.formatTime ?? defaultFormatTime)
  try {
    const native = new Notification({ title, body })
    if (notification.worktreeId && deps.focus) {
      const worktreeId = notification.worktreeId
      const paneKey = notification.paneKey
      native.on('click', () => deps.focus?.(worktreeId, paneKey))
    }
    native.show()
  } catch (error) {
    deps.logger?.warn('[auto-resume] notification failed', error)
  }
}
