import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options
} from './journal-domain-lifecycle.test-fixture'
import { journalSqlReads } from './journal-sql-reads'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { rewindRefusalBehindClear } from '../agent-session-wire/rewind/structured-rewind-refusal'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))
const prompt: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Request' }]
}

it('admits only the containing turn opener and refuses cleared history', async () => {
  const f = domainLifecycleFixture(cleanup)
  const reads = journalSqlReads(
    { point: async (request) => readJournalSqlPoint(f.db, request) },
    'chat'
  )
  await f.run({ kind: 'item', identity: identity('old'), body: prompt, options })
  await f.run({
    kind: 'item',
    identity: identity('clear'),
    body: {
      kind: 'status',
      text: 'Cleared',
      contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 1 }
    },
    options
  })
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    body: { kind: 'turn', turnId: 'turn', userItemId: 'orca:opener', state: 'completed' },
    options
  })
  for (const id of ['opener', 'steer']) {
    await f.run({
      kind: 'item',
      identity: identity(id),
      body: prompt,
      options: { fence: 1, turnScope: { kind: 'turn', turnItemId: 'orca:turn' } }
    })
  }
  const selected = await reads.rewindTarget('orca:opener')
  expect(selected).toMatchObject({ eligible: true, floor: { sequence: 2 } })
  expect((await reads.rewindTarget('orca:steer')).eligible).toBe(false)
  expect((await reads.rewindTarget('orca:old')).eligible).toBe(false)
  expect((await reads.rewindTarget('orca:missing')).eligible).toBe(false)
  const target = { itemId: 'orca:old', expectedEpoch: selected.cursor.epoch }
  expect(await rewindRefusalBehindClear({ reads }, target)).toMatchObject({ ok: false })
  expect(await rewindRefusalBehindClear({ reads }, { ...target, itemId: 'orca:opener' })).toBeNull()
  expect(
    await rewindRefusalBehindClear({ reads }, { ...target, expectedEpoch: 'retired' })
  ).toMatchObject({ refusal: { rewindReason: 'stale-epoch' } })
})
