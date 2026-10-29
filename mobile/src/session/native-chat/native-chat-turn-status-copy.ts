import type { Translate } from '../../i18n/mobile-i18n'
import {
  describeNativeChatActiveTurnLabel,
  describeNativeChatTurnStatus
} from '../../../../src/shared/native-chat-turn-status'

export function formatMobileNativeChatDuration(seconds: number, t: Translate): string {
  const totalSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  if (totalSeconds < 60) {
    const count = totalSeconds
    return count === 1
      ? t('chat.turnStatus.seconds_one', '{{count}}s', { count })
      : t('chat.turnStatus.seconds_other', '{{count}}s', { count })
  }
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60
  return minutes < 60
    ? t('chat.turnStatus.minutesSeconds', '{{minutes}}m {{seconds}}s', {
        minutes,
        seconds: remainingSeconds
      })
    : t('chat.turnStatus.hoursMinutesSeconds', '{{hours}}h {{minutes}}m {{seconds}}s', {
        hours: Math.floor(minutes / 60),
        minutes: minutes % 60,
        seconds: remainingSeconds
      })
}

export function formatMobileNativeChatTurnStatusLabel(
  input: Parameters<typeof describeNativeChatTurnStatus>[0],
  t: Translate
): string {
  const { key } = describeNativeChatTurnStatus(input)
  const duration = formatMobileNativeChatDuration(input.workedSeconds ?? input.elapsedSeconds, t)
  return nativeChatTurnStatusCopy(t, duration)[key]
}

export function formatMobileNativeChatActiveTurnLabel(
  input: Parameters<typeof describeNativeChatActiveTurnLabel>[0],
  t: Translate
): string {
  const label = describeNativeChatActiveTurnLabel(input)
  return label.source === 'activity' ? label.text : nativeChatTurnStatusCopy(t)[label.key]
}

export function nativeChatTurnStatusCopy(t: Translate, value0?: string) {
  return {
    thinking: t('chat.turnStatus.thinking', 'Thinking'),
    working: t('chat.turnStatus.working', 'Working…'),
    stopping: t('chat.turnStatus.stopping', 'Stopping…'),
    queueAfterStop: t('chat.turnStatus.queueAfterStop', 'Queue a message to run after the stop'),
    sendAfterStop: t('chat.turnStatus.sendAfterStop', 'Send a message to run after the stop'),
    workingFor: t('chat.turnStatus.workingFor', 'Working for {{value0}}', { value0 }),
    workedFor: t('chat.turnStatus.workedFor', 'Worked for {{value0}}', { value0 }),
    interruptedAfter: t('chat.turnStatus.interruptedAfter', 'Interrupted after {{value0}}', {
      value0
    }),
    failedAfter: t('chat.turnStatus.failedAfter', 'Failed after {{value0}}', { value0 }),
    toggleDetails: t('chat.turnStatus.toggleDetails', 'Toggle turn details'),
    responding: t('chat.turnStatus.responding', 'Agent is responding')
  }
}
