import type { NativeChatSessionOptionSettingsMutation } from '../../../../shared/native-chat/input/native-chat-session-options'
import { confirmsListedEffortAtSend } from '../../../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'

/** Saved picks seed unattended chats (bots, workers, automations), so an effort that a send may
 *  refuse is never saved; the pick still applies to the chat it was made in. */
export function withoutSendCheckedEffortPicks(
  mutation: NativeChatSessionOptionSettingsMutation
): NativeChatSessionOptionSettingsMutation {
  if (mutation.type !== 'apply-picks' || !confirmsListedEffortAtSend(mutation.agent)) {
    return mutation
  }
  const picks = mutation.picks.filter((pick) => pick.optionId !== 'effort')
  return picks.length === mutation.picks.length ? mutation : { ...mutation, picks }
}
