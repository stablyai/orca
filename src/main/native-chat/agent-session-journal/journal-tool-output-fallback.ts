import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from './journal-store'
import type { JournalAppendResult } from './journal-store-contracts'
import { AgentSessionJournalError } from './journal-write-guards'
import { boundToolInput, DEFAULT_JOURNAL_PAYLOAD_LIMITS } from './journal-payload-bounds'

export async function appendToolOutputFallback(input: {
  journal: AgentSessionJournal
  error: unknown
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  blobs: readonly { digest: string; payload: string }[]
  itemId: string
  fence: number
}): Promise<JournalAppendResult> {
  if (
    !(input.error instanceof AgentSessionJournalError) ||
    input.error.code !== 'journal_bound_exceeded' ||
    input.body.kind !== 'tool-call' ||
    input.body.state === 'running' ||
    input.blobs.length === 0
  ) {
    throw input.error
  }
  const digest = input.blobs[0]?.digest ?? 'unknown'
  const cursor = await input.journal.appendLifecycleBatch({
    settlementId: `tool-output-unavailable:${input.itemId}:${digest}`,
    fence: input.fence,
    mutations: [
      {
        kind: 'item',
        identity: input.identity,
        body: {
          kind: 'tool-call',
          name: input.body.name,
          input: boundToolInput(input.body.input, DEFAULT_JOURNAL_PAYLOAD_LIMITS),
          state: input.body.state
        }
      },
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: `output-unavailable:${input.itemId}` },
        body: {
          kind: 'status',
          text: 'The tool completed, but its output could not be retained within the session storage limit.'
        }
      }
    ]
  })
  const item = input.journal.snapshot().items.find((entry) => entry.itemId === input.itemId)
  if (!item) {
    throw new Error('journal_tool_output_fallback_lost')
  }
  return { cursor, itemId: input.itemId, revision: item.revision }
}
