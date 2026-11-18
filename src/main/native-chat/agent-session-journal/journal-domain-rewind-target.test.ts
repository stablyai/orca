import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options,
  lifecycleTarget as target
} from './journal-domain-lifecycle.test-fixture'
import { journalSqlReads } from './journal-sql-reads'
import { readJournalSqlPoint } from './journal-sql-point-read'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))
const prompt: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Request' }]
}

it("admits a Claude turn's opener, which the turn names by its send's echo", async () => {
  const f = domainLifecycleFixture(cleanup)
  const reads = journalSqlReads(
    { point: async (request) => readJournalSqlPoint(f.db, request) },
    'chat'
  )
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    body: { kind: 'turn', turnId: 'turn', userItemId: 'claude:provider:echo', state: 'completed' },
    options
  })
  await f.run({
    kind: 'item',
    identity: identity('opener'),
    body: prompt,
    options: { fence: 1, turnScope: { kind: 'turn', turnItemId: 'orca:turn' } }
  })
  f.db
    .prepare(
      'INSERT INTO journal_item_aliases(session_id,epoch,provider_item_id,item_id) VALUES(?,?,?,?)'
    )
    .run(target.sessionId, target.epoch, 'claude:provider:echo', 'orca:opener')
  expect((await reads.rewindTarget('orca:opener')).eligible).toBe(true)
})
