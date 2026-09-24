import { describe, expect, it, vi } from 'vitest'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget,
  type StructuredAgentSessionEventSink,
  type StructuredAgentSessionReadingControl
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { blockOf } from './claude-background-task-row-test-support'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'

function controlledSink(): {
  sink: StructuredAgentSessionEventSink
  control: () => StructuredAgentSessionReadingControl | undefined
  unbind: ReturnType<typeof vi.fn>
} {
  let control: StructuredAgentSessionReadingControl | undefined
  const unbind = vi.fn()
  return {
    sink: {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      bindReadingControl: (next) => {
        control = next
        return unbind
      }
    },
    control: () => control,
    unbind
  }
}

function persistedTarget(
  persisted: Map<string, AgentJournalItemBody>
): StructuredAgentSessionEventTarget {
  const journal =
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test double implements the journal methods exercised by the deferred sink.
    {
      appendItem: async (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
        persisted.set(agentJournalItemKey(identity), body)
        return { cursor: { epoch: 'test', sequence: persisted.size }, itemId: '', revision: 1 }
      },
      appendTombstone: vi.fn(),
      visitItems: (
        visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void
      ) => {
        for (const [itemId, body] of persisted) {
          visit(itemId, 0, body)
        }
      },
      itemBody: (itemId: string) => persisted.get(itemId) ?? null,
      epoch: 'test'
    } as unknown as AgentSessionJournal
  return { journal, fence: 1, publish: vi.fn() }
}

describe('Claude structured reading control', () => {
  it('binds sink pressure to SDK reading and unbinds on requested close', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    const events = controlledSink()

    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: events.sink
    })

    const pauseReading = vi.spyOn(claude.connections[0], 'pauseReading')
    const resumeReading = vi.spyOn(claude.connections[0], 'resumeReading')
    events.control()?.pauseReading()
    expect(pauseReading).toHaveBeenCalledOnce()
    events.control()?.resumeReading()
    expect(resumeReading).toHaveBeenCalledOnce()

    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(events.unbind).toHaveBeenCalledOnce()
  })

  it('unbinds when acquisition fails after the connection opens', async () => {
    const claude = fakeClaude({ initProof: 'none' })
    const adapter = adapterFor(claude, {}, [], [], 1)
    const events = controlledSink()

    await expect(
      adapter.acquire({
        identity: identityFor(),
        fence: 7,
        spawnToken: 'spawn-9',
        events: events.sink
      })
    ).rejects.toThrow('did not finish starting')
    expect(events.unbind).toHaveBeenCalledOnce()
  })

  it('unbinds when the published provider exits unexpectedly', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    const events = controlledSink()
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: events.sink
    })

    claude.connections[0].handlers.onExit?.(new Error('provider exited'))
    await adapter.drainObservedExits()

    expect(events.unbind).toHaveBeenCalledOnce()
  })

  it('keeps delivery ownership until a reported provider exit finishes closing', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    const events = controlledSink()
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: events.sink
    })
    const connection = claude.connections[0]

    connection.handlers.onExit?.(new Error('provider exited'))
    connection.handlers.onMessage?.({
      type: 'system',
      subtype: 'task_notification',
      session_id: PROVIDER_SESSION_ID,
      task_id: 'held-terminal-frame',
      status: 'failed',
      summary: 'The final task outcome'
    })

    expect(events.sink.appendItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'message',
        role: 'system',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'background-task',
            taskId: 'held-terminal-frame',
            summary: 'The final task outcome'
          })
        ])
      }),
      expect.anything()
    )
    await adapter.drainObservedExits()
    expect(events.unbind).toHaveBeenCalledOnce()
  })

  it('releases SDK reading when a pending row becomes permanently refused', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    const events = controlledSink()
    events.sink.tryAppendResolvedItemAndPublish = vi
      .fn()
      .mockReturnValueOnce({ accepted: false, reason: 'backpressure' })
      .mockReturnValueOnce({ accepted: false, reason: 'failed' })
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: events.sink
    })
    const resumeReading = vi.spyOn(claude.connections[0], 'resumeReading')
    claude.connections[0].handlers.onMessage?.({
      type: 'system',
      subtype: 'task_notification',
      session_id: PROVIDER_SESSION_ID,
      task_id: 'failed-journal-row',
      status: 'failed',
      summary: 'failed'
    })

    events.control()?.pauseReading()
    events.control()?.resumeReading()

    expect(resumeReading).toHaveBeenCalledOnce()
    await adapter.drainObservedExits()
  })

  it('automatically retries a hard-watermark row before resuming SDK reads', async () => {
    const persisted = new Map<string, AgentJournalItemBody>()
    const target = persistedTarget(persisted)
    const deferred = createDeferredStructuredAgentSessionEventSink({
      watermarks: {
        pauseQueuedOperations: 1,
        maxQueuedOperations: 4,
        lowQueuedOperations: 0,
        maxQueuedBytes: 1_000_000
      }
    })
    deferred.bind(target)
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: deferred.sink
    })
    await deferred.drained()
    persisted.clear()

    const appendEntered = Promise.withResolvers<void>()
    const appendGate = Promise.withResolvers<void>()
    const appendItem = target.journal.appendItem.bind(target.journal)
    vi.spyOn(target.journal, 'appendItem').mockImplementationOnce(async (...args) => {
      appendEntered.resolve()
      await appendGate.promise
      return appendItem(...args)
    })
    const resumeReading = vi.spyOn(claude.connections[0], 'resumeReading')
    deferred.sink.appendItem(
      { provider: 'orca', clientMessageId: 'blocked-prefill' },
      { kind: 'message', role: 'system', blocks: [{ type: 'text', text: 'prefill' }] }
    )
    await appendEntered.promise
    const notification = {
      type: 'system',
      subtype: 'task_notification',
      session_id: PROVIDER_SESSION_ID,
      task_id: 'hard-watermark-task',
      tool_use_id: 'toolu-hard-watermark',
      status: 'failed',
      summary: 'The real provider task failed',
      uuid: 'hard-watermark-notification'
    }
    claude.connections[0].handlers.onMessage?.(notification)
    claude.connections[0].handlers.onMessage?.(notification)
    expect(deferred.state().queuedOperations).toBe(4)

    appendGate.resolve()
    await vi.waitFor(() => expect(resumeReading).toHaveBeenCalledOnce())
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    const taskRows = [...persisted.values()].filter(
      (body) => body.kind === 'message' && blockOf(body)?.taskId === 'hard-watermark-task'
    )
    expect(taskRows).toHaveLength(1)
    expect(blockOf(taskRows[0])?.summary).toBe('The real provider task failed')
    expect(
      [...persisted.values()].some(
        (body) =>
          body.kind === 'status' && body.providerFrame?.kind.includes('task_notification') === true
      )
    ).toBe(false)
    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
  })
})
