import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'

/** Retries occupy the existing activity surface until the provider resumes or exhausts them. */
export function piRpcRetryActivity(frame: JsonlRpcRecord): ProviderTimelineEvent {
  return {
    type: 'activity',
    text:
      frame.type === 'auto_retry_start'
        ? agentSessionFailureWords(
            agentSessionFailureFact('providerRetrying', {
              detail:
                typeof frame.errorMessage === 'string'
                  ? providerDiagnostic(frame.errorMessage, 'person')
                  : undefined
            }),
            { agentName: 'Pi', surface: 'row' }
          ).text
        : null
  }
}
