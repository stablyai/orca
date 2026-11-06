import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'

/** Publications that ride frames but never write journal rows; the newest of each kind wins. */
export function createStructuredAgentSessionTransientMembers(
  queue: StructuredAgentSessionSinkQueue
): Required<Pick<StructuredAgentSessionEventSink, 'setActivity' | 'setPromptSuggestion'>> {
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
        bytes: Buffer.byteLength(suggestion ?? '', 'utf8') + 64,
        publicationKey: 'prompt-suggestion',
        run: (bound) => bound.publish(undefined, suggestion)
      })
    }
  }
}
