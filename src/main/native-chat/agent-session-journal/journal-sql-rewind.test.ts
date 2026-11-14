import { afterEach, expect, it } from 'vitest'
import { rewindMessage, sqlRewindFixture } from './journal-sql-rewind.test-fixture'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))
const native = (turnId: string, ordinal: number, threadId = 'thread') => ({
  provider: 'codex' as const,
  threadId,
  turnId,
  ordinal
})
const host = (clientMessageId: string) => ({ provider: 'orca' as const, clientMessageId })

it('keeps late child output and queued input in place, while removing the target and earlier refused input', async () => {
  const f = sqlRewindFixture(cleanup)
  await f.write(host('kept-turn'), {
    kind: 'turn',
    turnId: 'old',
    providerTurnId: 'old',
    state: 'running'
  })
  await f.write(native('old', 0), rewindMessage('first', 'user'))
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'refused',
      body: rewindMessage('refused', 'user'),
      payloadFingerprint: 'refused',
      fence: 1,
      origin: 'client',
      source: { kind: 'user' }
    }
  })
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'refused',
      state: 'rejected',
      fence: 1,
      ...agentSessionFailureWords(
        agentSessionFailureFact('cancelled', { neverReachedAgent: true }),
        { surface: 'rejection' }
      )
    }
  })
  await f.write(native('next', 0), rewindMessage('target', 'user'))
  await f.write(host('next-turn'), {
    kind: 'turn',
    turnId: 'next',
    providerTurnId: 'next',
    state: 'running'
  })
  await f.write(native('child-turn', 1, 'child'), rewindMessage('late child reply'), {
    turnScope: { kind: 'turn', turnItemId: 'orca:kept-turn' },
    ownerFence: 0,
    executionOwner: 0
  })
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'queued',
      body: rewindMessage('queued', 'user'),
      payloadFingerprint: 'queued',
      fence: 1,
      handoverRecorded: true,
      origin: 'client',
      source: { kind: 'user' }
    }
  })
  const late = f.item('codex:child:child-turn:1')
  const queued = f.item('orca:queued')
  const { complete } = f.prepare('codex:thread:next:0')
  f.db
    .prepare('UPDATE journal_items SET payload_json=? WHERE item_id=?')
    .run('unreadable original', 'codex:thread:old:0')
  const result = await complete()
  expect(
    f.db.prepare('SELECT payload_json FROM journal_items WHERE item_id=?').get('codex:thread:old:0')
      ?.payload_json
  ).toBe('unreadable original')
  expect(f.item('codex:child:child-turn:1')).toEqual(late)
  expect(f.item('orca:queued')).toEqual(queued)
  expect(f.item('codex:thread:next:0')).toBeUndefined()
  expect(f.item('orca:refused')).toBeUndefined()
  expect(
    f.db
      .prepare('SELECT owner_fence,execution_owner FROM journal_items WHERE item_id=?')
      .get('codex:child:child-turn:1')
  ).toEqual({ owner_fence: 0, execution_owner: 0 })
  expect(f.readRecord().rewind).toMatchObject({ phase: 'completed', epoch: result.cursor.epoch })
  expect(result.cursor.epoch).not.toBe('epoch')
  expect(result.requestEvents).toEqual([])
  await f.write(native('next', 0), rewindMessage('replacement', 'user'))
  expect(f.item('codex:thread:next:0')?.revision).toBe(3)
})

it('cuts accepted provider aliases at their scoped opener while keeping late output from the preceding turn', async () => {
  const f = sqlRewindFixture(cleanup)
  await f.write(host('kept-turn'), {
    kind: 'turn',
    turnId: 'host-old',
    providerTurnId: 'old:/ turn',
    state: 'running'
  })
  await f.write(native('old:/ turn', 0), rewindMessage('kept', 'user'))
  await f.write(host('hidden-owner'), {
    kind: 'turn',
    turnId: 'host-next',
    providerTurnId: 'next:/ turn',
    state: 'running'
  })
  f.db.prepare('UPDATE journal_items SET hidden=1 WHERE item_id=?').run('orca:hidden-owner')
  await f.write(host('scoped-opener'), rewindMessage('target opener', 'user'), {
    turnScope: { kind: 'turn', turnItemId: 'orca:hidden-owner' }
  })
  await f.write(host('between'), rewindMessage('after the actual boundary'))
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'target',
      body: rewindMessage('target', 'user'),
      payloadFingerprint: 'target',
      fence: 1,
      origin: 'client',
      source: { kind: 'user' }
    }
  })
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'target',
      state: 'accepted',
      fence: 1,
      providerIdentity: native('next:/ turn', 0)
    }
  })
  await f.write(native('late', 1, 'child'), rewindMessage('kept late output'), {
    turnScope: { kind: 'turn', turnItemId: 'orca:kept-turn' }
  })
  const { complete } = f.prepare('orca:target')
  await complete()
  expect(f.item('orca:scoped-opener')).toBeUndefined()
  expect(f.item('orca:between')).toBeUndefined()
  expect(f.item('orca:target')).toBeUndefined()
  expect(f.item('codex:thread:old%3A%2F%20turn:0')?.body).toEqual(rewindMessage('kept', 'user'))
  expect(f.item('codex:child:late:1')?.body).toEqual(rewindMessage('kept late output'))
})

it('rolls the cut and usage-limit cancellation back with its receipt and completes both on retry', async () => {
  const f = sqlRewindFixture(cleanup)
  await f.write(native('old', 0), rewindMessage('kept request', 'user'))
  await f.write(host('kept-turn'), {
    kind: 'turn',
    turnId: 'old',
    state: 'completed',
    outcome: 'failure',
    startedAt: 1,
    completedAt: 2
  })
  await f.write(
    host('limit'),
    {
      kind: 'status',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', { usageLimit: { resetsAt: 1700000060000 } }),
        { surface: 'row' }
      )
    },
    { turnScope: { kind: 'turn', turnItemId: 'orca:kept-turn' } }
  )
  await f.write(native('next', 0), rewindMessage('target', 'user'))
  const { complete } = f.prepare('codex:thread:next:0')
  f.db.exec(`CREATE TRIGGER reject_rewind BEFORE UPDATE ON agent_session_records
    WHEN json_extract(NEW.record_json,'$.rewind.phase')='completed'
    BEGIN SELECT RAISE(ABORT,'completion refused'); END`)
  await expect(complete()).rejects.toThrow('completion refused')
  expect(f.item('codex:thread:next:0')?.body).toMatchObject({ role: 'user' })
  expect(f.readRecord().rewind?.phase).toBe('provider-succeeded')
  expect(f.readRecord().usageLimitContinueCancel).toBeUndefined()
  expect(
    JSON.parse(
      String(f.db.prepare('SELECT row_json FROM agent_session_operations').get()!.row_json)
    ).outcome
  ).toEqual({ status: 'pending' })
  f.db.exec('DROP TRIGGER reject_rewind')
  await complete()
  expect(f.item('codex:thread:next:0')).toBeUndefined()
  expect(f.readRecord().usageLimitContinueCancel).toEqual({
    turnItemId: 'orca:kept-turn',
    resetsAt: 1700000060000
  })
  expect(
    JSON.parse(
      String(f.db.prepare('SELECT row_json FROM agent_session_operations').get()!.row_json)
    ).outcome
  ).toMatchObject({ status: 'succeeded' })
})

it('keeps the cleared prefix and late Claude turn rows, remapping the inherited anchor inside the same commit', async () => {
  const f = sqlRewindFixture(cleanup, 'claude')
  const claude = (uuid: string) => ({ provider: 'claude' as const, sessionId: 'native', uuid })
  await f.write(claude('prefix'), rewindMessage('before clear'))
  const boundary = { operationId: 'clear-1', afterFence: 1, clearedAt: 10 }
  const clear = await f.run({ kind: 'context-clear', boundary })
  await f.write(host('kept-turn'), { kind: 'turn', turnId: 'kept', state: 'running' })
  await f.write(claude('kept'), rewindMessage('kept prompt', 'user'), {
    turnScope: { kind: 'turn', turnItemId: 'orca:kept-turn' }
  })
  await f.write(claude('target'), rewindMessage('target', 'user'))
  await f.write(host('next-turn'), { kind: 'turn', turnId: 'next', state: 'running' })
  await f.write(claude('late'), rewindMessage('late reply'), {
    turnScope: { kind: 'turn', turnItemId: 'orca:kept-turn' }
  })
  const prefix = f.item('claude:native:prefix')
  const { complete } = f.prepare(
    'claude:native:target',
    {
      expectedEpoch: clear.cursor.epoch,
      contextClearOperationId: 'clear-1',
      contextClearSequence: Number(
        f.db.prepare('SELECT sequence FROM journal_items WHERE context_clear=1').get()!.sequence
      ),
      providerFork: {
        sessionId: 'forked',
        sourceSessionId: 'native',
        replacesSessionId: 'native',
        materialized: true
      }
    },
    {
      providerContextBoundary: boundary,
      forkedFrom: {
        sessionId: 'source-chat',
        itemId: 'source-item',
        childBoundary: { kind: 'item', itemId: 'claude:native:target' }
      }
    }
  )
  const result = await complete()
  expect(f.item('claude:native:prefix')).toEqual(prefix)
  expect(f.item('claude:native:late')?.body).toMatchObject({
    blocks: [{ type: 'text', text: 'late reply' }]
  })
  expect(f.item('claude:native:target')).toBeUndefined()
  expect(result.cursor.epoch).toBe(clear.cursor.epoch)
  expect(f.readRecord().forkedFrom?.childBoundary).toEqual({
    kind: 'item',
    itemId: 'claude:native:kept'
  })
  expect(f.readRecord().providerHandleChain.at(-1)?.handle.nativeId).toBe('forked')
})
