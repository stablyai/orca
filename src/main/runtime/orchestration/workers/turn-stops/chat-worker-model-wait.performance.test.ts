import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

const SESSION = testOrcaSessionId('7a1c3e55-2b8d-4f90-9c16-3d5e8f0a7b42')
const MINUTE = 60_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
})

// Incident: a chat worker's tool streaming its output commits its row on every chunk, and each
// commit read the row again (#46628 follow-up). Reads per item now coalesce to one in flight.
it('reads a streaming tool row once per read in flight, not once per commit', async () => {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'ship',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coordinator:11111111-1111-4111-8111-111111111111'
  })
  createRootDispatch(
    db,
    db.createTask({ spec: 'work', runId: run.id }).id,
    formatOrcaSessionAddress(SESSION)
  )
  let body: AgentJournalItemBody = {
    kind: 'tool-call',
    name: 'Bash',
    input: { command: 'make' },
    state: 'running'
  }
  let reads = 0
  const answers: (() => void)[] = []
  const answerReads = async () => {
    while (answers.length > 0) {
      answers.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
  }
  const feed: { onItems?: (ids: readonly string[] | null) => void } = {}
  const journal: ChatModelWaitJournal = {
    observe: (_sessionId, listener) => {
      feed.onItems = listener
      return () => {}
    },
    item: (_sessionId, itemId) => {
      reads += 1
      // The test answers each read, so commits pile up while one is in flight.
      return new Promise((resolve) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watch reads only these fields.
        answers.push(() => resolve({ itemId, body } as AgentJournalRenderItem))
      })
    }
  }
  const watch = new ChatWorkerModelWait(
    { getDb: () => db, notify: () => {}, isWaitingForMail: () => false },
    journal
  )
  watch.observe(SESSION, 'working')
  for (let chunk = 0; chunk < 100; chunk++) {
    feed.onItems?.(['tool-1'])
  }
  await answerReads()
  expect(reads).toBe(2)

  // The latest revision still lands: the tool's end restarts the stopwatch.
  body = { ...body, state: 'completed' }
  feed.onItems?.(['tool-1'])
  await answerReads()
  await vi.advanceTimersByTimeAsync(10 * MINUTE)
  expect(db.getUnreadRunMailbox(run.id, 100, ['escalation'])).toHaveLength(1)
  watch.dispose()
  db.close()
})
