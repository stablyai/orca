import type {
  AgentSessionPromptSuggestion,
  AgentSessionTurnActivity
} from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'

/** State readers see but the journal never keeps; a newer value replaces one still buffered. */
export function structuredAgentSessionEphemeralPublications(
  queue: Pick<StructuredAgentSessionSinkQueue, 'submit'>
): {
  setActivity: (activity: AgentSessionTurnActivity | null) => void
  setPromptSuggestion: (suggestion: AgentSessionPromptSuggestion | null) => void
} {
  return {
    setActivity: (activity) => {
      queue.submit({
        bytes: Buffer.byteLength(JSON.stringify(activity), 'utf8') + 64,
        publicationKey: 'turn-activity',
        run: (bound) => bound.publish(activity)
      })
    },
    setPromptSuggestion: (suggestion) => {
      queue.submit({
        bytes: Buffer.byteLength(JSON.stringify(suggestion), 'utf8') + 64,
        publicationKey: 'prompt-suggestion',
        run: (bound) => bound.publishPromptSuggestion?.(suggestion)
      })
    }
  }
}
