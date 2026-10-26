import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { JournalLifecycleMutationInput } from '../native-chat/agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionEventTarget } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { withJournalQueueMembers } from '../native-chat/agent-session-wire/structured-agent-session-journal-double-test-support'

export function deferredTarget(
  log: AgentJournalItemBody[],
  publishes: string[] = []
): StructuredAgentSessionEventTarget {
  return {
    fence: 7,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a double for the journal members this path calls; the helper adds the in-order ones.
    journal: withJournalQueueMembers({
      appendItem: async (_identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
        log.push(body)
        return { cursor: { epoch: 'e', sequence: log.length } }
      },
      appendTombstone: async () => ({ epoch: 'e', sequence: log.length }),
      // Holds no rows to read back, so a turn row's revision is its lifecycle.
      itemBody: () => null,
      appendLifecycleBatch: async (input: {
        mutations: readonly JournalLifecycleMutationInput[]
      }) => {
        for (const mutation of input.mutations) {
          if (mutation.kind === 'item') {
            log.push(mutation.body)
          }
        }
        return { epoch: 'e', sequence: log.length }
      }
    }) as unknown as StructuredAgentSessionEventTarget['journal'],
    publish: () => {
      publishes.push('publish')
    }
  }
}
