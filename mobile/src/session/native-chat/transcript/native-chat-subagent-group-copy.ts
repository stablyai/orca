import type {
  NativeChatSubagentGroupCopyId,
  NativeChatSubagentGroupSay
} from '../../../../../src/shared/native-chat/transcript/native-chat-subagent-group-header'
import { translate } from '../../../i18n/mobile-i18n'

export const sayMobileNativeChatSubagentGroup: NativeChatSubagentGroupSay = (id, values) => {
  const count = values?.count
  const copy = {
    stateCompleted: () => translate('chat.subagentGroup.stateCompleted', 'completed'),
    stateWorking: () => translate('chat.subagentGroup.stateWorking', 'working'),
    stateIdle: () => translate('chat.subagentGroup.stateIdle', 'idle'),
    stateFailed: () => translate('chat.subagentGroup.stateFailed', 'failed'),
    stateStopped: () => translate('chat.subagentGroup.stateStopped', 'stopped'),
    stateUnverifiable: () =>
      translate('chat.subagentGroup.stateUnverifiable', 'status unavailable'),
    stateWorkingCount: () =>
      count === 1
        ? translate('chat.subagentGroup.stateWorkingCount_one', '{{count}} working', { count })
        : translate('chat.subagentGroup.stateWorkingCount_other', '{{count}} working', { count }),
    stateIdleCount: () =>
      count === 1
        ? translate('chat.subagentGroup.stateIdleCount_one', '{{count}} idle', { count })
        : translate('chat.subagentGroup.stateIdleCount_other', '{{count}} idle', { count }),
    stateFailedCount: () =>
      count === 1
        ? translate('chat.subagentGroup.stateFailedCount_one', '{{count}} failed', { count })
        : translate('chat.subagentGroup.stateFailedCount_other', '{{count}} failed', { count }),
    stateStoppedCount: () =>
      count === 1
        ? translate('chat.subagentGroup.stateStoppedCount_one', '{{count}} stopped', { count })
        : translate('chat.subagentGroup.stateStoppedCount_other', '{{count}} stopped', { count }),
    stateUnverifiableCount: () =>
      count === 1
        ? translate(
            'chat.subagentGroup.stateUnverifiableCount_one',
            '{{count}} with status unavailable',
            { count }
          )
        : translate(
            'chat.subagentGroup.stateUnverifiableCount_other',
            '{{count}} with status unavailable',
            { count }
          ),
    started: () =>
      count === 1
        ? translate('chat.subagentGroup.started_one', 'Kicked off {{count}} subagent', { count })
        : translate('chat.subagentGroup.started_other', 'Kicked off {{count}} subagents', {
            count
          }),
    ran: () =>
      count === 1
        ? translate('chat.subagentGroup.ran_one', 'Ran {{count}} subagent', { count })
        : translate('chat.subagentGroup.ran_other', 'Ran {{count}} subagents', { count }),
    tokens: () => translate('chat.subagentGroup.tokens', '{{value0}} tokens', values)
  } satisfies Record<NativeChatSubagentGroupCopyId, () => string>
  return copy[id]()
}
