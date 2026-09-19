import { Notification } from 'electron'
import type { NotificationSettings } from '../shared/notification-settings-types'
import { translateMain } from './i18n/main-i18n'
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
    return translateMain('agentAutoResume.notification.resetTimeUnknown', 'the reset time')
  }
}

function buildDetectedBody(notification: AgentAutoResumeNotification, when: string | null): string {
  if (when === null) {
    return translateMain(
      'agentAutoResume.notification.detected.bodyUnknownReset',
      'Orca will auto-resume it when the limit resets.'
    )
  }
  // The menu path's `resumesAt` is when Orca answers the CLI's chooser, not when
  // the agent runs again: the limit itself can have hours left after that. Only
  // the banner path's time is a resume time, so only it may be called one.
  if (notification.reason === 'usage-limit-menu') {
    return translateMain(
      'agentAutoResume.notification.detected.bodyMenuAt',
      'Orca will answer the rate-limit prompt at {{when}}, then wait out the limit.',
      { when }
    )
  }
  return translateMain(
    'agentAutoResume.notification.detected.bodyAt',
    'Orca will auto-resume it at {{when}}.',
    { when }
  )
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
      title: translateMain('agentAutoResume.notification.detected.title', 'Agent rate-limited'),
      body: buildDetectedBody(notification, when)
    }
  }
  if (notification.kind === 'dead-pty') {
    return {
      title: translateMain(
        'agentAutoResume.notification.deadPty.title',
        'Rate-limited agent exited'
      ),
      body: translateMain(
        'agentAutoResume.notification.deadPty.body',
        'The agent process exited while rate-limited. Reopen its worktree to resume the session.'
      )
    }
  }
  return {
    title: translateMain('agentAutoResume.notification.failed.title', 'Auto-resume failed'),
    body: translateMain(
      'agentAutoResume.notification.failed.body',
      "Orca couldn't resume the rate-limited agent. Resume it manually."
    )
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
