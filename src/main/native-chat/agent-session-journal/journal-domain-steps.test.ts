import { afterEach, expect, it, vi } from 'vitest'
import {
  domainLifecycleFixture,
  lifecycleIdentity as identity,
  lifecycleOptions as options
} from './journal-domain-lifecycle.test-fixture'
import type { JournalWriterStep } from './writing/journal-writer-step'
import type { AgentJournalApprovalItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

const cleanups: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})
const literal = (id: string): JournalWriterStep => ({
  kind: 'item',
  identity: identity(id),
  body: { kind: 'status', text: id },
  options,
  reservedBytes: 4096
})
const pending: AgentJournalApprovalItem = {
  kind: 'approval',
  title: 'Run?',
  detail: null,
  options: [{ id: 'allow', label: 'Allow' }],
  resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
}

it('keeps streamed text revisions and placement across reopen and refuses text after its turn ends', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    body: { kind: 'turn', turnId: 't', state: 'running' },
    options
  })
  const snapshot = (text: string) =>
    f.run({
      kind: 'steps',
      steps: [
        {
          kind: 'resolved-item',
          reservedBytes: 4096,
          options: { ...options, turnScope: { kind: 'turn', turnItemId: 'orca:turn' } },
          resolution: {
            kind: 'text-snapshot',
            identity: identity('text'),
            body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
          }
        }
      ]
    })
  await snapshot('First')
  await snapshot('Second')
  await snapshot('Third')
  expect(f.item('orca:text')).toMatchObject({
    revision: 3,
    sequence: 2,
    observedAt: 100,
    body: { blocks: [{ text: 'Third' }] },
    turnScope: { kind: 'turn', turnItemId: 'orca:turn' }
  })
  f.reopen()
  await snapshot('After restart')
  expect(f.item('orca:text')).toMatchObject({
    revision: 4,
    sequence: 2,
    body: { blocks: [{ text: 'After restart' }] }
  })
  await f.run({
    kind: 'item',
    identity: identity('turn'),
    body: { kind: 'turn', turnId: 't', state: 'completed' },
    options
  })
  expect((await snapshot('Too late')).value).toMatchObject({
    outcomes: [{ kind: 'dropped', reason: 'turn-settled', turnItemId: 'orca:turn' }]
  })
  expect(f.item('orca:text')).toMatchObject({
    revision: 4,
    body: { blocks: [{ text: 'After restart' }] }
  })
})

it('commits the successful step prefix with only its actual payloads and skips the failed suffix', async () => {
  const f = domainLifecycleFixture(cleanups)
  f.db.exec(
    `CREATE TRIGGER refuse_step BEFORE INSERT ON journal_items WHEN NEW.item_id='orca:refused' BEGIN SELECT RAISE(ABORT,'step refused'); END`
  )
  const result = await f.run({
    kind: 'steps',
    steps: [literal('first'), literal('refused'), literal('suffix')]
  })
  expect(result.value).toMatchObject({
    outcomes: [{ kind: 'committed', wrote: true }],
    failure: { message: 'step refused' },
    cursor: { epoch: 'epoch', sequence: 1 }
  })
  expect(result.publication?.items.map((item) => item.itemId)).toEqual(['orca:first'])
  expect(f.item('orca:refused')).toBeUndefined()
  expect(f.item('orca:suffix')).toBeUndefined()
  expect(result.publication?.invalidatedItemIds).toEqual(['orca:first'])
})

it('settles current tools and turns and refuses a later provider close or text revival', async () => {
  const f = domainLifecycleFixture(cleanups)
  const inTurn = { kind: 'turn' as const, turnItemId: 'orca:turn' }
  const steps: JournalWriterStep[] = [
    {
      kind: 'resolved-item',
      options,
      reservedBytes: 4096,
      resolution: {
        kind: 'turn-open',
        identity: identity('turn'),
        body: { kind: 'turn', turnId: 't', state: 'running' }
      }
    },
    {
      kind: 'resolved-item',
      options: { ...options, turnScope: inTurn },
      reservedBytes: 4096,
      resolution: {
        kind: 'guarded-item',
        identity: identity('tool'),
        body: { kind: 'tool-call', name: 'read', input: {}, state: 'running' },
        change: 'open'
      }
    },
    {
      kind: 'settlement',
      settlementId: 'ended',
      fence: 1,
      reservedBytes: 8192,
      resolution: {
        kind: 'timeline-settlement',
        scope: 'session',
        keep: [],
        ending: { turns: 'running', end: { state: 'interrupted', completedAt: 80 } }
      }
    },
    {
      kind: 'resolved-item',
      options: { ...options, turnScope: inTurn },
      reservedBytes: 4096,
      resolution: {
        kind: 'guarded-item',
        identity: identity('tool'),
        body: { kind: 'tool-call', name: 'read', input: {}, state: 'completed' },
        change: 'close'
      }
    },
    {
      kind: 'resolved-item',
      options: { ...options, turnScope: inTurn },
      reservedBytes: 4096,
      resolution: {
        kind: 'text-snapshot',
        identity: identity('late-text'),
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'late' }] }
      }
    }
  ]
  const result = await f.run({ kind: 'steps', steps })
  expect(result.value).toMatchObject({
    outcomes: [
      { kind: 'committed', wrote: true },
      { kind: 'committed', wrote: true },
      { kind: 'committed', wrote: true },
      { kind: 'dropped', reason: 'item-settled' },
      { kind: 'dropped', reason: 'turn-settled', turnItemId: 'orca:turn' }
    ]
  })
  expect(f.item('orca:tool')?.body).toMatchObject({ state: 'failed', endedAs: 'interrupted' })
  expect(f.item('orca:turn')?.body).toMatchObject({ state: 'interrupted', completedAt: 80 })
  expect(f.item('orca:late-text')).toBeUndefined()
})

it('verifies history authority at the write position and accepts a proven current revision only', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(100)
  const f = domainLifecycleFixture(cleanups)
  await f.run({ kind: 'item', identity: identity('prompt'), body: pending, options })
  const permit = new Int32Array(new SharedArrayBuffer(4))
  Atomics.store(permit, 0, 1)
  const settlement: JournalWriterStep = {
    kind: 'settlement',
    settlementId: 'history',
    fence: 1,
    reservedBytes: 8192,
    resolution: {
      kind: 'history-catch-up',
      expectedCursor: { epoch: 'epoch', sequence: 1 },
      expectedItems: [{ key: 'orca:prompt', canonicalItemId: 'orca:prompt', revision: 1 }],
      permit,
      deadline: 60100,
      mutations: [
        {
          kind: 'item',
          identity: identity('prompt'),
          body: {
            ...pending,
            resolution: {
              state: 'resolved',
              selectedOptionId: 'allow',
              resolvedBy: 'user',
              resolvedAt: 60
            }
          },
          turnScope: { kind: 'thread' }
        }
      ]
    }
  }
  const stale = await f.run({ kind: 'steps', steps: [literal('earlier-write'), settlement] })
  expect(stale.value).toMatchObject({
    outcomes: [{ kind: 'committed', wrote: true }, { kind: 'dropped' }]
  })
  expect(f.item('orca:prompt')?.body).toMatchObject({ resolution: { state: 'pending' } })
  if (settlement.resolution.kind !== 'history-catch-up') {
    throw new Error('expected history')
  }
  settlement.resolution.expectedCursor = { epoch: 'epoch', sequence: 2 }
  const valid = await f.run({ kind: 'steps', steps: [settlement] })
  expect(valid.value).toMatchObject({ outcomes: [{ kind: 'committed', wrote: true }] })
  expect(f.item('orca:prompt')?.body).toMatchObject({
    resolution: { state: 'resolved', selectedOptionId: 'allow' }
  })
})

it('chooses request incarnations and lets earlier prompt answers win over a withdrawal', async () => {
  const f = domainLifecycleFixture(cleanups)
  const request = { agent: 'grok' as const, sessionId: 'chat', generation: 'g1', key: 'p1' }
  const open: JournalWriterStep = {
    kind: 'resolved-item',
    options,
    reservedBytes: 4096,
    resolution: { kind: 'request-open', request, body: pending, turnItemId: null }
  }
  const created = await f.run({ kind: 'steps', steps: [open, open] })
  expect(created.value).toMatchObject({
    outcomes: [{ kind: 'committed', wrote: true }, { kind: 'dropped' }]
  })
  const item = created.publication!.items[0]!
  const answer = await f.run({
    kind: 'prompt-mutate',
    input: {
      itemId: item.itemId,
      expectedRevision: 1,
      resolution: {
        state: 'resolved',
        selectedOptionId: 'allow',
        resolvedBy: 'user',
        resolvedAt: 60
      },
      options
    }
  })
  expect(answer.value).toMatchObject({ itemId: item.itemId, revision: 2 })
  await f.run({
    kind: 'steps',
    steps: [
      {
        kind: 'settlement',
        settlementId: 'withdraw',
        fence: 1,
        reservedBytes: 4096,
        resolution: { kind: 'request-withdrawn', request }
      }
    ]
  })
  expect(f.item(item.itemId)?.body).toMatchObject({ resolution: { state: 'resolved' } })
  await expect(
    f.run({
      kind: 'prompt-mutate',
      input: {
        itemId: item.itemId,
        expectedRevision: 1,
        resolution: {
          state: 'cancelled',
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: null
        },
        options
      }
    })
  ).rejects.toMatchObject({ refusal: { code: 'agent_session_item_revision_stale' } })
  const next = await f.run({ kind: 'steps', steps: [open] })
  expect(next.publication?.items[0]?.itemId).not.toBe(item.itemId)
})
