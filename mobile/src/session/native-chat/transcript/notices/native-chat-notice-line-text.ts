import type { NativeChatTextBlock } from '../../../../../../src/shared/native-chat/native-chat-types'
import { readWholeAgentSessionFailureFact } from '../../../../../../src/shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../../../src/shared/agent-session/failures/agent-session-failure-words'
import { nativeChatOrcaStopRowText } from '../../../../../../src/shared/native-chat/transcript/continuation/native-chat-orca-stop-words'
import type { MobileNativeChatNoticeView } from './mobile-native-chat-notice-context'
import { nativeChatOrcaStopSay } from './native-chat-orca-stop-copy'
import { nativeChatRestartNoteText } from './native-chat-restart-note-copy'
import { nativeChatUsageLimitText } from './native-chat-usage-limit-copy'
import { mobileAgentSessionFailureSay } from '../../agent-session/agent-session-failure-copy'
import type { Translate } from '../../../../i18n/mobile-i18n'

// The phone always reads its Orca host as remote.
export function noticeLineText(
  notice: NativeChatTextBlock,
  names: MobileNativeChatNoticeView,
  t: Translate
): string {
  if (notice.orcaStop) {
    const say = nativeChatOrcaStopSay(t)
    return nativeChatOrcaStopRowText(
      notice.orcaStop.cause,
      names.hostName ?? say('unnamedServer'),
      { continueAvailable: names.continuation?.continueAvailable === true, remoteHost: true },
      say
    )
  }
  const failure = readWholeAgentSessionFailureFact(notice.failure)
  if (failure?.kind === 'usageLimitReached') {
    return nativeChatUsageLimitText(failure.usageLimit, names.agentName, t)
  }
  // Only reword text fully described by its fact; other host text stays as written.
  const context = { agentName: names.agentName }
  const surface =
    failure &&
    [
      'savedConversationMissing',
      'pluginInputRequired',
      'modelUnavailable',
      'providerUnavailable',
      'providerSafetyStopped',
      'providerResponseFailed'
    ].includes(failure.kind)
      ? (['row', 'rejection'] as const).find(
          (candidate) => notice.text === agentSessionFailureSentence(failure, candidate, context)
        )
      : undefined
  return failure && surface
    ? agentSessionFailureSentence(failure, surface, context, mobileAgentSessionFailureSay(t))
    : (nativeChatRestartNoteText(notice.text, t) ?? notice.text)
}
