import { afterEach, expect, it } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options
} from './journal-domain-lifecycle.test-fixture'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { journalSqlReads } from './journal-sql-reads'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))

// A settled turn is no generation row, so only the teardown anchor can name its opener.
it('resolves the Claude opener through its echo alias for teardown and rewind', async () => {
  const f = domainLifecycleFixture(cleanup)
  const claude = { provider: 'claude' as const, sessionId: 'provider', uuid: 'asked' }
  const message = (text: string) => ({
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text }]
  })
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'asked',
      fence: 1,
      body: message('asked'),
      payloadFingerprint: 'a',
      handoverRecorded: true
    }
  })
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'asked',
      fence: 1,
      state: 'pending',
      turnScope: { kind: 'turn', turnItemId: 'orca:asked-turn' }
    }
  })
  await f.run({
    kind: 'dispatch',
    input: { clientMessageId: 'asked', fence: 1, state: 'accepted', providerIdentity: claude }
  })
  await f.run({
    kind: 'item',
    identity: identity('asked-turn'),
    options,
    body: {
      kind: 'turn',
      turnId: 'asked-turn',
      state: 'completed',
      outcome: 'success',
      userItemId: agentJournalItemKey(claude)
    }
  })
  // A later message is the newest prompt, so only the turn's own opener names the asked one.
  await f.run({
    kind: 'submission',
    input: { clientMessageId: 'later', fence: 1, body: message('later'), payloadFingerprint: 'l' }
  })
  const reads = journalSqlReads(
    { point: async (request) => readJournalSqlPoint(f.db, request) },
    'chat'
  )
  const { items } = await reads.generation({ teardownAnchors: true })
  expect(items.map((item) => item.itemId)).toContain('orca:asked')
  expect(await reads.rewindTarget('orca:asked')).toMatchObject({ eligible: true })
})
