import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { ChatWorkerModelWait, type ChatModelWaitJournal } from './chat-worker-model-wait'
import { claudeApiRetryRowBody } from '../../../../claude/structured/journal/claude-api-retry-row'

const SESSION = testOrcaSessionId('5d2f8a71-3c9e-4b60-8e14-7a6c2b9d0f35')

function rig() {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'ship',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
  })
  const task = db.createTask({ spec: 'work', runId: run.id })
  createRootDispatch(db, task.id, formatOrcaSessionAddress(SESSION))
  const items = new Map<string, AgentJournalRenderItem>()
  let onItems: ((ids: readonly string[] | null) => void) | null = null
  const journal: ChatModelWaitJournal = {
    observe: (_sessionId, listener) => {
      onItems = listener
      return () => {
        onItems = null
      }
    },
    item: async (_sessionId, itemId) => items.get(itemId) ?? null
  }
  const watch = new ChatWorkerModelWait(
    { getDb: () => db, notify: () => {}, isWaitingForMail: () => false },
    journal
  )
  /** The chat's journal changed this item. */
  const write = async (itemId: string, body: AgentJournalItemBody) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watch reads only these fields.
    items.set(itemId, { itemId, body } as AgentJournalRenderItem)
    onItems?.([itemId])
    await vi.advanceTimersByTimeAsync(0)
  }
  const mail = () =>
    db
      .getUnreadRunMailbox(run.id, 100, ['escalation', 'status'])
      .map((message) => ({ type: message.type, subject: message.subject, body: message.body }))
  return { db, watch, write, mail }
}

const retry = (attempt: number): AgentJournalItemBody =>
  claudeApiRetryRowBody({
    type: 'system',
    subtype: 'api_retry',
    attempt,
    max_retries: 8,
    error: 'overloaded'
  })

describe('a chat worker retrying its model API', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps a credential in the retry's words out of the coordinator's mail", async () => {
    const { db, watch, write, mail } = rig()
    watch.observe(SESSION, 'working')
    const leaky = { ...retry(1), text: 'Retrying: Bearer abc123SECRETxyz was refused' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a provider's echo can put any words in the row.
    await write('retry-1', leaky as AgentJournalItemBody)
    expect(mail()).toHaveLength(1)
    expect(mail()[0]?.body).not.toContain('abc123SECRETxyz')
    watch.dispose()
    db.close()
  })
})
