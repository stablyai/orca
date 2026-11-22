import { afterEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { createLegacyProviderTimelineIdentityScheme } from '../agent-session-timeline/provider-timeline-identity'
import { acpSessionNotRestoredItem } from '../../acp/session/start/acp-session-reopen-failure'
import {
  domainLifecycleFixture,
  lifecycleOptions as options
} from './journal-domain-lifecycle.test-fixture'
import type { JournalWriterStep } from './writing/journal-writer-step'
import type { JournalDomainImportItem } from './journal-domain-import'
import { insertJournalDomainImportPage } from './journal-domain-import-rows'
import { runJournalTransaction } from './database/journal-database'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function warningIdentity(namespace: string, lostKey: string, agent = 'grok') {
  return createLegacyProviderTimelineIdentityScheme({ agent, sessionId: 'chat' }).item({
    namespace,
    family: 'item',
    key: { source: 'provider', value: acpSessionNotRestoredItem(lostKey) },
    thread: namespace
  })
}

const warning = (
  namespace: string,
  lostKey: string
): Extract<JournalWriterStep, { kind: 'resolved-item' }> => ({
  kind: 'resolved-item',
  options,
  reservedBytes: 4096,
  resolution: {
    kind: 'acp-loss-warning',
    identity: warningIdentity(namespace, lostKey),
    body: { kind: 'status', tone: 'warning', text: 'The earlier session could not be reopened.' }
  }
})

it('uses surviving source-order writes for duplicate warnings and retries a rolled-back warning', async () => {
  const f = domainLifecycleFixture(cleanups)
  f.db.exec(`CREATE TRIGGER refuse_loss BEFORE INSERT ON journal_items
    WHEN NEW.legacy_provider_item_key='session-not-restored%3Asecond'
    BEGIN SELECT RAISE(ABORT,'loss refused'); END`)
  const first = await f.run({
    kind: 'steps',
    steps: [warning('a', 'first'), warning('b', 'first'), warning('b', 'second')]
  })
  expect(first.value).toMatchObject({
    outcomes: [{ kind: 'committed', wrote: true }, { kind: 'dropped' }],
    failure: { message: 'loss refused' },
    cursor: { epoch: 'epoch', sequence: 1 }
  })
  const originalId = agentJournalItemKey(warningIdentity('a', 'first'))
  const original = f.item(originalId)
  expect(first.publication?.items.map((item) => item.itemId)).toEqual([originalId])
  f.db.exec('DROP TRIGGER refuse_loss')
  f.reopen()
  const retry = await f.run({
    kind: 'steps',
    steps: [warning('c', 'first'), warning('c', 'second'), warning('d', 'second')]
  })
  expect(retry.value).toMatchObject({
    outcomes: [{ kind: 'dropped' }, { kind: 'committed', wrote: true }, { kind: 'dropped' }],
    cursor: { epoch: 'epoch', sequence: 2 }
  })
  expect(f.item(originalId)).toEqual(original)
  expect(retry.publication?.items).toHaveLength(1)
})

it('preserves imported semantic duplicates across writers and body kinds until their visible rows are removed', async () => {
  const f = domainLifecycleFixture(cleanups)
  f.db.exec('DELETE FROM journal_chat_state')
  const firstIdentity = warningIdentity('old/writer', 'escaped:/% ☃', 'omp')
  const secondIdentity = warningIdentity('another:writer', 'escaped:/% ☃', 'grok')
  const longKey = 'long-key'.repeat(100)
  const imported = [firstIdentity, secondIdentity, warningIdentity('old', longKey)].map(
    (identity, index): JournalDomainImportItem => ({
      ordinal: index + 1,
      ownerFence: 1,
      executionOwner: null,
      hidden: false,
      item: {
        itemId: agentJournalItemKey(identity),
        revision: 3,
        sequence: index + 1,
        observedAt: 12,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'saved' }] },
        turnScope: { kind: 'thread' }
      },
      turnItemId: null,
      originalStopNoteJson: null,
      queueCommandTurn: false,
      queueFailedOutcome: false,
      queueFailedAt: 0,
      queueFailureWitnessedThrough: 0,
      queueFailureReportTurnItemId: null
    })
  )
  runJournalTransaction(f.db, () =>
    insertJournalDomainImportPage(
      f.db,
      { sessionId: 'chat', epoch: 'epoch' },
      {
        kind: 'items',
        rows: imported
      }
    )
  )
  f.db
    .exec(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',3,1)`)
  const held = imported.map(({ item }) => item)
  expect(
    (
      await f.run({
        kind: 'steps',
        steps: [warning('new', 'escaped:/% ☃'), warning('new', longKey)]
      })
    ).value
  ).toMatchObject({ outcomes: [{ kind: 'dropped' }, { kind: 'dropped' }] })
  expect(held.map((item) => f.item(item.itemId))).toEqual(held)
  await f.run({ kind: 'tombstone', identity: firstIdentity, fence: 1 })
  expect(
    (await f.run({ kind: 'steps', steps: [warning('new', 'escaped:/% ☃')] })).value
  ).toMatchObject({ outcomes: [{ kind: 'dropped' }] })
  await f.run({ kind: 'tombstone', identity: secondIdentity, fence: 1 })
  expect(
    (await f.run({ kind: 'steps', steps: [warning('new', 'escaped:/% ☃')] })).value
  ).toMatchObject({ outcomes: [{ kind: 'committed', wrote: true }] })
})

it('rejects stale direct and nested warning writers before suppressing a matching warning', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({ kind: 'steps', steps: [warning('a', 'first')] })
  const originalId = agentJournalItemKey(warningIdentity('a', 'first'))
  const original = f.item(originalId)
  f.db.exec("UPDATE journal_chat_state SET highest_fence=2 WHERE session_id='chat'")
  for (const lostKey of ['first', 'missing']) {
    const direct = warning('b', lostKey)
    const nested: JournalWriterStep = {
      ...direct,
      resolution: {
        kind: 'stop-decided',
        turnId: 'turn',
        endedAt: 2,
        ran: direct.resolution,
        stopped: null
      }
    }
    for (const step of [direct, nested]) {
      const result = await f.run({ kind: 'steps', steps: [step] })
      expect(result.value).toMatchObject({
        outcomes: [],
        failure: { code: 'journal_stale_fence' },
        cursor: { epoch: 'epoch', sequence: 1 }
      })
      expect(result.publication?.items).toEqual([])
    }
  }
  const ordinary = await f.run({
    kind: 'steps',
    steps: [
      {
        kind: 'resolved-item',
        reservedBytes: 4096,
        options,
        resolution: {
          kind: 'turn-claim',
          identity: { provider: 'orca', clientMessageId: 'ordinary-claim' },
          providerTurnId: 'provider-turn'
        }
      }
    ]
  })
  expect(ordinary.value).toMatchObject({ outcomes: [{ kind: 'dropped' }] })
  expect(ordinary.value).not.toHaveProperty('failure')
  expect(f.item(originalId)).toEqual(original)
})

it('does not suppress a missing warning for hidden rows, another physical epoch or an alias alone', async () => {
  const f = domainLifecycleFixture(cleanups)
  const hidden = warningIdentity('old', 'hidden')
  const retired = warningIdentity('old', 'retired')
  for (const identity of [hidden, retired]) {
    await f.run({ kind: 'item', identity, body: { kind: 'status', text: 'saved' }, options })
  }
  f.db.prepare('UPDATE journal_items SET hidden=1 WHERE item_id=?').run(agentJournalItemKey(hidden))
  f.db
    .prepare("UPDATE journal_items SET epoch='retired' WHERE item_id=?")
    .run(agentJournalItemKey(retired))
  await f.run({
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: 'alias-target' },
    body: { kind: 'status', text: 'saved' },
    options
  })
  f.db
    .prepare(`INSERT INTO journal_item_aliases(session_id,epoch,provider_item_id,item_id,echo_declared)
    VALUES('chat','epoch',?,'orca:alias-target',0)`)
    .run(agentJournalItemKey(warningIdentity('new', 'alias')))
  expect(
    (
      await f.run({
        kind: 'steps',
        steps: [warning('new', 'hidden'), warning('new', 'retired'), warning('new', 'alias')]
      })
    ).value
  ).toMatchObject({
    outcomes: [
      { kind: 'committed', wrote: true },
      { kind: 'committed', wrote: true },
      { kind: 'committed', wrote: true }
    ]
  })
})
