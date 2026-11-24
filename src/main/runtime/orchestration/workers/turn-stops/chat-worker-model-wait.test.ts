import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
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

it('starts fresh model-wait notices when history replaces an earlier retry', async () => {
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
  const feed: { onItems?: Parameters<ChatModelWaitJournal['observe']>[1] } = {}
  const retry = agentSessionFailureWords(agentSessionFailureFact('providerRetrying'), {
    surface: 'row'
  })
  const watch = new ChatWorkerModelWait(
    { getDb: () => db, notify: () => {}, isWaitingForMail: () => false },
    {
      observe: (_sessionId, listener) => {
        feed.onItems = listener
        return () => {}
      },
      item: async (_sessionId, itemId) => ({
        itemId,
        revision: 1,
        sequence: 1,
        observedAt: Date.now(),
        body: { kind: 'status', ...retry }
      })
    }
  )
  try {
    watch.observe(SESSION, 'working')
    feed.onItems?.(['old-retry'])
    await vi.advanceTimersByTimeAsync(1)
    feed.onItems?.(null)
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    feed.onItems?.(null, true)
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    feed.onItems?.(['new-retry'])
    await vi.advanceTimersByTimeAsync(0)
    const notices = db.getUnreadRunMailbox(run.id).flatMap(({ payload }) => {
      const entry = payload ? JSON.parse(payload) : null
      return entry?.modelWait
        ? [{ kind: entry.modelWait, hasLastSeen: entry.lastSeen !== undefined }]
        : []
    })
    expect(notices).toEqual([
      { kind: 'retrying', hasLastSeen: true },
      { kind: 'waiting', hasLastSeen: true },
      { kind: 'waiting', hasLastSeen: false },
      { kind: 'retrying', hasLastSeen: true }
    ])
  } finally {
    watch.dispose()
    db.close()
  }
})
