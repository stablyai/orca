import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget
} from './structured-agent-session-event-sink'

const BODY: AgentJournalItemBody = {
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'hi' }]
}

function identity(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

type Recorded = { call: string; fence?: number; ordinal?: number }

function target(
  fence: number,
  log: Recorded[],
  failOn?: number
): StructuredAgentSessionEventTarget {
  const journal = {
    appendItem: vi.fn(async (id: AgentJournalItemIdentity, _body: AgentJournalItemBody) => {
      const ordinal = id.provider === 'codex' ? id.ordinal : -1
      if (ordinal === failOn) {
        throw new Error(`refused ${ordinal}`)
      }
      log.push({ call: 'appendItem', fence, ordinal })
      return { cursor: { epoch: 'e', sequence: ordinal } }
    }),
    appendTombstone: vi.fn(async (id: AgentJournalItemIdentity) => {
      log.push({
        call: 'appendTombstone',
        fence,
        ordinal: id.provider === 'codex' ? id.ordinal : -1
      })
      return { epoch: 'e', sequence: 0 }
    })
  } as unknown as AgentSessionJournal
  return { journal, fence, publish: () => log.push({ call: 'publish', fence }) }
}

describe('deferred structured agent-session event sink', () => {
  it('buffers writes made before the journal exists and drains them in arrival order', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink()

    deferred.sink.appendItem(identity(0), BODY)
    deferred.sink.appendItem(identity(1), BODY)
    deferred.sink.publish()
    expect(log).toEqual([])

    deferred.bind(target(7, log))
    await deferred.drained()

    expect(log).toEqual([
      { call: 'appendItem', fence: 7, ordinal: 0 },
      { call: 'appendItem', fence: 7, ordinal: 1 },
      { call: 'publish', fence: 7 }
    ])
  })

  it('writes at the fence bound at submission time, so a rebind cannot backdate a write', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink()
    deferred.bind(target(1, log))

    deferred.sink.appendItem(identity(0), BODY)
    // The re-attach that raised the fence.
    deferred.bind(target(2, log))
    deferred.sink.appendItem(identity(1), BODY)
    await deferred.drained()

    expect(log).toEqual([
      { call: 'appendItem', fence: 1, ordinal: 0 },
      { call: 'appendItem', fence: 2, ordinal: 1 }
    ])
  })

  it('buffers replacement-acquisition events while unbound', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink()
    deferred.bind(target(1, log))
    deferred.unbind()

    deferred.sink.appendItem(identity(0), BODY)
    expect(log).toEqual([])
    deferred.bind(target(2, log))
    await deferred.drained()

    expect(log).toEqual([{ call: 'appendItem', fence: 2, ordinal: 0 }])
  })

  it('drops buffered and later writes once closed, and refuses to rebind', async () => {
    const log: Recorded[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink()

    deferred.sink.appendItem(identity(0), BODY)
    deferred.close()
    deferred.bind(target(3, log))
    deferred.sink.appendItem(identity(1), BODY)
    await deferred.drained()

    expect(log).toEqual([])
  })

  it('reports a refused append and keeps draining the rest', async () => {
    const log: Recorded[] = []
    const errors: unknown[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink({
      onError: (error) => errors.push(error)
    })
    deferred.bind(target(4, log, 0))

    deferred.sink.appendItem(identity(0), BODY)
    deferred.sink.appendTombstone(identity(1))
    await deferred.drained()

    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('refused 0')
    expect(log).toEqual([{ call: 'appendTombstone', fence: 4, ordinal: 1 }])
  })
})
