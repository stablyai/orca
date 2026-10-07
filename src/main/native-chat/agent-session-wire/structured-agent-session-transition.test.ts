import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalToolCallItem
} from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createAgentSessionDeltaCoalescer } from './agent-session-delta-coalescer'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionSinkWatermarks
} from './structured-agent-session-event-sink'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'
import type {
  StructuredAgentSessionTransition,
  StructuredAgentSessionTransitionStep
} from './structured-agent-session-transition'

const SESSION = 'session-transition'
const journals = createTrackedJournalOpener()
const roots: string[] = []

afterEach(async () => {
  await journals.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function identity(recordId: string): AgentJournalItemIdentity {
  return { provider: 'legacy', agent: 'grok', sessionId: SESSION, recordId }
}

function tool(name: string, state: AgentJournalToolCallItem['state']): AgentJournalToolCallItem {
  return { kind: 'tool-call', name, input: { name }, state }
}

function failedTool(id: AgentJournalItemIdentity): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    identity: id,
    body: tool('read', 'failed'),
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}

function itemStep(
  resolve: Extract<StructuredAgentSessionTransitionStep, { kind: 'item' }>['resolve'],
  reservedBytes = 4096
): StructuredAgentSessionTransitionStep {
  return {
    kind: 'item',
    reservedBytes,
    resolve,
    options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  }
}

async function rig(watermarks: Partial<StructuredAgentSessionSinkWatermarks> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orca-transition-'))
  roots.push(root)
  const journal: AgentSessionJournal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'grok',
      providerHandle: { transport: 'acp', agent: 'grok', nativeId: 'provider-session-1' }
    },
    stateDirectory: root,
    now: () => 1_000
  })
  const publishes: number[] = []
  const deferred = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging(SESSION),
    watermarks
  })
  const bind = () => deferred.bind({ journal, fence: 1, publish: () => publishes.push(1) })
  return { root, journal, deferred, sink: deferred.sink, publishes, bind }
}

describe('structured agent-session transitions', () => {
  it('lands its steps back to back, each resolved after the one before it', async () => {
    const { journal, deferred, sink, publishes, bind } = await rig()
    bind()
    const first = identity('first')
    const transition: StructuredAgentSessionTransition = {
      lifecycle: false,
      publish: true,
      steps: [
        itemStep(() => ({ identity: first, body: tool('read', 'running') })),
        // Reads the row the step before it wrote.
        itemStep((view) => {
          const before = view.itemBody(agentJournalItemKey(first))
          return before?.kind === 'tool-call'
            ? { identity: identity('second'), body: tool(`after-${before.name}`, 'running') }
            : null
        })
      ]
    }
    expect(sink.tryAppendTransition?.(transition)).toEqual({ accepted: true })
    sink.tryAppendItem?.(identity('later'), tool('later', 'running'), {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await deferred.drained()

    const items = journal.snapshot().items
    const start = items[0]?.sequence ?? 0
    expect(items.map((item) => [item.itemId, item.sequence - start])).toEqual([
      [agentJournalItemKey(first), 0],
      [agentJournalItemKey(identity('second')), 1],
      [agentJournalItemKey(identity('later')), 2]
    ])
    expect(items[1]?.body).toMatchObject({ name: 'after-read' })
    expect(publishes).toHaveLength(1)
  })

  it('admitted whole is not executed whole: a failed step keeps the ones before it and fails the sink', async () => {
    const { journal, deferred, sink, publishes, bind } = await rig()
    bind()
    sink.tryAppendTransition?.({
      lifecycle: false,
      publish: true,
      steps: [
        itemStep(() => ({ identity: identity('kept'), body: tool('read', 'running') })),
        itemStep(() => {
          throw new Error('resolver failed')
        })
      ]
    })

    await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
      agentJournalItemKey(identity('kept'))
    ])
    expect(publishes).toEqual([])
    expect(
      sink.tryAppendTransition?.({
        lifecycle: false,
        publish: false,
        steps: [itemStep(() => null)]
      })
    ).toEqual({ accepted: false, reason: 'failed' })
  })

  it('writes nothing after a step that overflows its reservation', async () => {
    const { journal, deferred, sink, publishes, bind } = await rig()
    bind()
    const after = vi.fn(() => ({ identity: identity('third'), body: tool('read', 'running') }))
    sink.tryAppendTransition?.({
      lifecycle: false,
      publish: true,
      steps: [
        itemStep(() => ({ identity: identity('first'), body: tool('read', 'running') })),
        itemStep(
          () => ({ identity: identity('second'), body: tool('x'.repeat(10_000), 'running') }),
          64
        ),
        itemStep(after)
      ]
    })

    await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
      agentJournalItemKey(identity('first'))
    ])
    expect(after).not.toHaveBeenCalled()
    expect(publishes).toEqual([])
  })

  it('opens no next-turn work after a settlement the journal refused', async () => {
    const { journal, deferred, sink, bind } = await rig()
    bind()
    const old = identity('old-tool')
    sink.tryAppendItem?.(old, tool('read', 'running'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await deferred.drained()
    sink.tryAppendTransition?.({
      lifecycle: true,
      publish: true,
      steps: [
        itemStep(() => ({ identity: identity('before'), body: tool('read', 'completed') })),
        // Names one item twice, which the journal refuses.
        {
          kind: 'settlement',
          settlementId: 'settle',
          reservedBytes: 1,
          resolve: () => [failedTool(old), failedTool(old)]
        },
        itemStep(() => ({ identity: identity('next-turn-work'), body: tool('read', 'running') }))
      ]
    })

    await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
      agentJournalItemKey(old),
      agentJournalItemKey(identity('before'))
    ])
    expect(journal.item(agentJournalItemKey(old))?.body).toMatchObject({ state: 'running' })
  })

  it('writes nothing after a step whose row the database refused', async () => {
    const { root, journal, deferred, sink, bind } = await rig()
    bind()
    // Refuses only the second step's row, so the third would land in its place.
    openTestJournalHostDatabase(root).db.exec(`CREATE TEMP TRIGGER fail_second_step
BEFORE INSERT ON main.journal_rows WHEN instr(NEW.row_json, 'refused-step') > 0
BEGIN SELECT RAISE(ABORT, 'second step refused'); END`)
    const step = (recordId: string) =>
      itemStep(() => ({ identity: identity(recordId), body: tool(recordId, 'running') }))
    sink.tryAppendTransition?.({
      lifecycle: false,
      publish: true,
      steps: [step('first'), step('refused-step'), step('third')]
    })

    await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
      agentJournalItemKey(identity('first'))
    ])
  })

  it('refuses a transition whole, so none of its steps ever lands', async () => {
    const { journal, deferred, sink, bind } = await rig({ maxQueuedOperations: 1 })
    const step = (recordId: string) =>
      itemStep(() => ({ identity: identity(recordId), body: tool(recordId, 'running') }))
    const admitted = { lifecycle: false, publish: false, steps: [step('a')] }
    const refused = { lifecycle: false, publish: false, steps: [step('b'), step('c')] }

    expect(sink.tryAppendTransition?.(admitted)).toEqual({ accepted: true })
    expect(sink.tryAppendTransition?.(refused)).toEqual({
      accepted: false,
      reason: 'backpressure'
    })
    bind()
    await deferred.drained()

    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
      agentJournalItemKey(identity('a'))
    ])
  })

  it('settles from the rows as they stand, in consecutive rows when one cannot hold them', async () => {
    const { journal, deferred, sink, publishes, bind } = await rig()
    bind()
    const running = Array.from({ length: 250 }, (_, index) => identity(`tool-${index}`))
    for (const id of running) {
      sink.tryAppendItem?.(id, tool('read', 'running'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    }
    sink.tryAppendItem?.(identity('done'), tool('read', 'completed'), {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    expect(
      sink.tryAppendTransition?.({
        lifecycle: true,
        publish: true,
        steps: [
          {
            kind: 'settlement',
            settlementId: 'settle-all',
            reservedBytes: 1,
            // The settled row is a candidate too; the fold, not the caller, rules it out.
            resolve: (view) =>
              [...running, identity('done')].flatMap((id) => {
                const body = view.itemBody(agentJournalItemKey(id))
                return body?.kind === 'tool-call' && body.state === 'running'
                  ? [
                      {
                        kind: 'item' as const,
                        identity: id,
                        body: { ...body, state: 'failed' as const },
                        turnScope: AGENT_JOURNAL_THREAD_SCOPE
                      }
                    ]
                  : []
              })
          }
        ]
      })
    ).toEqual({ accepted: true })
    sink.tryAppendItem?.(identity('after'), tool('after', 'running'), {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await deferred.drained()

    const items = journal.snapshot().items
    const sequenceOf = (recordId: string) =>
      items.find((item) => item.itemId === agentJournalItemKey(identity(recordId)))?.sequence ?? 0
    expect(
      items.filter((item) => item.body.kind === 'tool-call' && item.body.state === 'failed')
    ).toHaveLength(250)
    expect(
      items.find((item) => item.itemId === agentJournalItemKey(identity('done')))?.body
    ).toMatchObject({ state: 'completed' })
    // Two batch rows, back to back, between the last append before it and the first after it.
    expect(sequenceOf('after') - sequenceOf('done')).toBe(3)
    expect(publishes).toHaveLength(1)
  })

  it('leaves no row of a settlement durable when a later one of its rows fails to write', async () => {
    const { root, journal, deferred, sink, bind } = await rig()
    bind()
    const running = Array.from({ length: 250 }, (_, index) => identity(`tool-${index}`))
    for (const id of running) {
      sink.tryAppendItem?.(id, tool('read', 'running'), { turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    }
    await deferred.drained()
    const before = journal.cursor().sequence
    // The settlement needs two rows; the second one's insert aborts inside the transaction.
    openTestJournalHostDatabase(root).db.exec(`CREATE TEMP TRIGGER fail_second_chunk
BEFORE INSERT ON main.journal_rows WHEN NEW.seq = ${before + 2}
BEGIN SELECT RAISE(ABORT, 'second chunk refused'); END`)
    sink.tryAppendTransition?.({
      lifecycle: true,
      publish: true,
      steps: [
        {
          kind: 'settlement',
          settlementId: 'settle-all',
          reservedBytes: 1,
          resolve: () => running.map(failedTool)
        }
      ]
    })

    await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
    expect(journal.cursor().sequence).toBe(before)
    expect(
      journal
        .snapshot()
        .items.filter((item) => item.body.kind === 'tool-call' && item.body.state === 'failed')
    ).toEqual([])
  })

  it('writes and announces nothing when a step resolves to nothing', async () => {
    const { journal, deferred, sink, publishes, bind } = await rig()
    bind()
    sink.tryAppendTransition?.({
      lifecycle: true,
      publish: true,
      steps: [
        itemStep(() => null),
        { kind: 'settlement', settlementId: 'none', reservedBytes: 1, resolve: () => [] }
      ]
    })
    await deferred.drained()

    expect(journal.snapshot().items).toEqual([])
    expect(publishes).toEqual([])
  })

  it('lands a write a step issues while it runs after the whole transition', async () => {
    const { journal, deferred, sink, bind } = await rig()
    bind()
    sink.tryAppendTransition?.({
      lifecycle: false,
      publish: false,
      steps: [
        itemStep(() => {
          // Another writer, reached from inside the step: it waits for the transition's turn to end.
          sink.tryAppendItem?.(identity('nested'), tool('nested', 'running'), {
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          })
          return { identity: identity('first'), body: tool('first', 'running') }
        }),
        itemStep(() => ({ identity: identity('second'), body: tool('second', 'running') }))
      ]
    })
    await deferred.drained()

    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual(
      ['first', 'second', 'nested'].map((recordId) => agentJournalItemKey(identity(recordId)))
    )
  })
})

describe('resolved lifecycle batches', () => {
  it('refuses, before writing anything, a settlement that names one item twice', async () => {
    const { journal } = await rig()
    const before = journal.cursor().sequence
    const twice = identity('twice')

    await expect(
      journal.appendSteps([
        {
          kind: 'settlement',
          batch: {
            settlementId: 'twice',
            fence: 1,
            resolve: () => [failedTool(identity('once')), failedTool(twice), failedTool(twice)]
          }
        }
      ])
    ).rejects.toThrow('journal_resolved_lifecycle_batch_names_item_twice')
    expect(journal.cursor().sequence).toBe(before)
  })
})

describe('coalescer text a caller writes itself', () => {
  it('reports unwritten streams and owes nothing once the caller marks them written', () => {
    const emitted: string[] = []
    const coalescer = createAgentSessionDeltaCoalescer({
      emit: (_key, text) => {
        emitted.push(text)
      },
      schedule: () => () => {}
    })
    coalescer.append('a', 'Hel')
    coalescer.append('b', 'Wor')
    coalescer.append('a', 'lo')

    expect(coalescer.dirty().map(({ key, snapshot }) => [key, snapshot.text])).toEqual([
      ['a', 'Hello'],
      ['b', 'Wor']
    ])
    coalescer.markFlushed('a')
    coalescer.flushAll()
    expect(emitted).toEqual(['Wor'])
    expect(coalescer.dirty()).toEqual([])
  })
})
