import { Notification } from 'electron'
import type { NotificationSettings } from '../shared/notification-settings-types'
import { retainNotificationUntilRelease } from './ipc/native-notification-lifecycle'
import { getEffectiveNotificationSoundId } from './ipc/notification-sound-selection'
import { translateMain } from './i18n/main-i18n'
import type { ScheduledMessageNotification } from './scheduled-message-service'

export type ScheduledMessageNotifierDeps = {
  getNotificationSettings: () => NotificationSettings
  /** Bring Orca forward and focus the affected workspace on click. */
  focus?: (worktreeId: string) => void
  logger?: Pick<Console, 'warn'>
}

function buildMissedBody(notification: ScheduledMessageNotification): string {
  // A limit that outlasted the wait is not "Orca was closed" — saying so sends the
  // user looking for a crash that never happened.
  if (notification.failureReason === 'usage-limit-outlasted') {
    return translateMain(
      'scheduledMessages.notification.missed.bodyUsageLimit',
      'The agent was still rate-limited long after it came due. It is waiting in Automations — send or reschedule it.'
    )
  }
  return translateMain(
    'scheduledMessages.notification.missed.body',
    'Orca was closed when it came due. It is waiting in Automations — send or reschedule it.'
  )
}

function buildContent(notification: ScheduledMessageNotification): {
  title: string
  body: string
} {
  if (notification.kind === 'sent') {
    return {
      title: translateMain('scheduledMessages.notification.sent.title', 'Scheduled message sent'),
      body: translateMain(
        'scheduledMessages.notification.sent.body',
        'Orca delivered your queued message to the agent.'
      )
    }
  }
  if (notification.kind === 'missed') {
    return {
      title: translateMain(
        'scheduledMessages.notification.missed.title',
        'Scheduled message missed'
      ),
      body: buildMissedBody(notification)
    }
  }
  const undeliveredTitle = translateMain(
    'scheduledMessages.notification.undelivered.title',
    "Scheduled message couldn't be delivered"
  )
  if (notification.failureReason === 'no-pane') {
    return {
      title: undeliveredTitle,
      body: translateMain(
        'scheduledMessages.notification.noPane.body',
        'That workspace had no open terminal. Open it, then use Send now in Automations.'
      )
    }
  }
  if (notification.failureReason === 'no-agent') {
    return {
      title: undeliveredTitle,
      body: translateMain(
        'scheduledMessages.notification.noAgent.body',
        'No agent was running in that workspace, so Orca refused to type into a plain shell.'
      )
    }
  }
  return {
    title: translateMain('scheduledMessages.notification.failed.title', 'Scheduled message failed'),
    body: translateMain(
      'scheduledMessages.notification.failed.body',
      "Orca couldn't send your queued message. It is still in Automations."
    )
  }
}

/** Unlike auto-resume, success IS notified: the user wrote this text hours ago and
 *  has no other signal that it landed. */
export function deliverScheduledMessageNotification(
  notification: ScheduledMessageNotification,
  deps: ScheduledMessageNotifierDeps
): void {
  const settings = deps.getNotificationSettings()
  if (settings.enabled !== true) {
    return
  }
  if (!Notification.isSupported()) {
    return
  }
  const { title, body } = buildContent(notification)
  try {
    // Anything but 'system' means Orca plays its own sound, so the OS one would
    // double up.
    const native = new Notification({
      title,
      body,
      silent: getEffectiveNotificationSoundId(settings) !== 'system'
    })
    // Without a strong reference, GC can collect the notification — and its click
    // handler — while it is still on screen.
    const release = retainNotificationUntilRelease(native)
    if (deps.focus) {
      const worktreeId = notification.worktreeId
      native.on('click', () => {
        release()
        deps.focus?.(worktreeId)
      })
    }
    native.on('failed', (_event, error) => {
      deps.logger?.warn('[scheduled-messages] notification delivery failed', error)
      release()
    })
    native.show()
  } catch (error) {
    deps.logger?.warn('[scheduled-messages] notification failed', error)
  }
}
