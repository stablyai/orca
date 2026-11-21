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

const SESSION = testOrcaSessionId('5d2f8a71-3c9e-4b60-8e14-7a6c2b9d0f35')
const MINUTE = 60_000

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
  let onItems: ((ids: readonly string[]) => void) | null = null
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

const retry = (attempt: number): AgentJournalItemBody => ({
  kind: 'status',
  tone: 'warning',
  text: `Claude hit a temporary problem and is retrying. Retry ${attempt} of 8.`,
  failure: { kind: 'providerRetrying' }
})
const tool = (state: 'running' | 'completed'): AgentJournalItemBody => ({
  kind: 'tool-call',
  name: 'Bash',
  input: { command: 'python3 longjob.py' },
  state
})
const reply = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  text
})

describe('a chat worker waiting on its model', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tells the coordinator once when a request gets no reply for 10 minutes', async () => {
    const { db, watch, mail } = rig()
    watch.observe(SESSION, true)
    await vi.advanceTimersByTimeAsync(9 * MINUTE)
    expect(mail()).toEqual([])
    await vi.advanceTimersByTimeAsync(1 * MINUTE)
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    expect(mail()).toEqual([
      {
        type: 'escalation',
        subject: 'Worker is waiting on the model',
        body: expect.stringContaining('has been waiting on the model for 10 min with no reply')
      }
    ])
    watch.dispose()
    db.close()
  })

  it('says nothing while a reply streams or a tool runs', async () => {
    const { db, watch, write, mail } = rig()
    watch.observe(SESSION, true)
    for (let minute = 0; minute < 12; minute++) {
      await write('reply-1', reply(`line ${minute}`))
      await vi.advanceTimersByTimeAsync(MINUTE)
    }
    await write('tool-1', tool('running'))
    await vi.advanceTimersByTimeAsync(25 * MINUTE)
    expect(mail()).toEqual([])
    watch.dispose()
    db.close()
  })

  it('restarts the stopwatch when the tool ends', async () => {
    const { db, watch, write, mail } = rig()
    watch.observe(SESSION, true)
    await write('tool-1', tool('running'))
    await vi.advanceTimersByTimeAsync(15 * MINUTE)
    await write('tool-1', tool('completed'))
    await vi.advanceTimersByTimeAsync(9 * MINUTE)
    expect(mail()).toEqual([])
    await vi.advanceTimersByTimeAsync(1 * MINUTE)
    expect(mail().map((message) => message.subject)).toEqual(['Worker is waiting on the model'])
    watch.dispose()
    db.close()
  })

  it("reports the first retry at once, and a retry still going at 10 minutes with the retry's words", async () => {
    const { db, watch, write, mail } = rig()
    watch.observe(SESSION, true)
    await write('retry-1', retry(1))
    for (let attempt = 2; attempt <= 6; attempt++) {
      await vi.advanceTimersByTimeAsync(2 * MINUTE)
      await write('retry-1', retry(attempt))
    }
    expect(mail()).toEqual([
      {
        type: 'status',
        subject: 'Worker is retrying the model API',
        body: expect.stringContaining(
          'Last seen: Claude hit a temporary problem and is retrying. Retry 1 of 8.'
        )
      },
      {
        type: 'escalation',
        subject: 'Worker is waiting on the model',
        body: expect.stringContaining(
          'Last seen: Claude hit a temporary problem and is retrying. Retry 5 of 8.'
        )
      }
    ])
    watch.dispose()
    db.close()
  })

  it('stops at the turn end', async () => {
    const { db, watch, mail } = rig()
    watch.observe(SESSION, true)
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    watch.observe(SESSION, false)
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(mail()).toEqual([])
    db.close()
  })
})
