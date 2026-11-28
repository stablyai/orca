import type {
  NativeChatSubagentGroupCopyId,
  NativeChatSubagentGroupSay
} from '../../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-group-header'
import type { Translate } from '../../../../i18n/mobile-i18n'

export function mobileNativeChatSubagentGroupSay(t: Translate): NativeChatSubagentGroupSay {
  return (id, values) => {
    const count = values?.count
    const copy = {
      stateCompleted: () => t('chat.subagentGroup.stateCompleted', 'completed'),
      stateWorking: () => t('chat.subagentGroup.stateWorking', 'working'),
      stateIdle: () => t('chat.subagentGroup.stateIdle', 'idle'),
      stateFailed: () => t('chat.subagentGroup.stateFailed', 'failed'),
      stateStopped: () => t('chat.subagentGroup.stateStopped', 'stopped'),
      stateUnverifiable: () => t('chat.subagentGroup.stateUnverifiable', 'status unavailable'),
      stateWorkingCount: () =>
        count === 1
          ? t('chat.subagentGroup.stateWorkingCount_one', '{{count}} working', { count })
          : t('chat.subagentGroup.stateWorkingCount_other', '{{count}} working', { count }),
      stateIdleCount: () =>
        count === 1
          ? t('chat.subagentGroup.stateIdleCount_one', '{{count}} idle', { count })
          : t('chat.subagentGroup.stateIdleCount_other', '{{count}} idle', { count }),
      stateFailedCount: () =>
        count === 1
          ? t('chat.subagentGroup.stateFailedCount_one', '{{count}} failed', { count })
          : t('chat.subagentGroup.stateFailedCount_other', '{{count}} failed', { count }),
      stateStoppedCount: () =>
        count === 1
          ? t('chat.subagentGroup.stateStoppedCount_one', '{{count}} stopped', { count })
          : t('chat.subagentGroup.stateStoppedCount_other', '{{count}} stopped', { count }),
      stateUnverifiableCount: () =>
        count === 1
          ? t(
              'chat.subagentGroup.stateUnverifiableCount_one',
              '{{count}} with status unavailable',
              { count }
            )
          : t(
              'chat.subagentGroup.stateUnverifiableCount_other',
              '{{count}} with status unavailable',
              { count }
            ),
      started: () =>
        count === 1
          ? t('chat.subagentGroup.started_one', 'Kicked off {{count}} subagent', { count })
          : t('chat.subagentGroup.started_other', 'Kicked off {{count}} subagents', {
              count
            }),
      ran: () =>
        count === 1
          ? t('chat.subagentGroup.ran_one', 'Ran {{count}} subagent', { count })
          : t('chat.subagentGroup.ran_other', 'Ran {{count}} subagents', { count }),
      tokens: () => t('chat.subagentGroup.tokens', '{{value0}} tokens', values)
    } satisfies Record<NativeChatSubagentGroupCopyId, () => string>
    return copy[id]()
  }
}
