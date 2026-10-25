import { describe, expect, it } from 'vitest'
import { handleMsg } from './document/host-message-router'
import { createTerminalDocumentScope } from './document/document-scope'
import {
  enqueueTerminalDataReplyBoundary,
  forwardTerminalDataReply,
  resetTerminalDataReplyAuthority
} from './document/query-reply'

type QueryReplyGate = {
  forward: (data: string) => void
  queueBoundary: (generation: number) => void
  reset: () => void
  clear: () => void
  setGeneration: (generation: number) => void
}

// Drive the real gate with scope-owned notify and queue fields; execute its enqueued boundary to model replay drain.
function createQueryReplyGate(notify: (message: unknown) => void): {
  gate: QueryReplyGate
  queuedBoundaries: (() => void)[]
} {
  const queuedBoundaries: (() => void)[] = []
  const scope = createTerminalDocumentScope({ postToHost: notify })
  const gate: QueryReplyGate = {
    forward: (data) => forwardTerminalDataReply(scope, data),
    queueBoundary: (generation) => {
      enqueueTerminalDataReplyBoundary(scope, generation)
      const queued = scope.writeQueue[scope.writeQueue.length - 1]
      if (typeof queued === 'function') {
        queuedBoundaries.push(queued)
      }
    },
    reset: () => resetTerminalDataReplyAuthority(scope),
    clear: () => handleMsg(scope, { type: 'clear' }),
    setGeneration: (next) => {
      scope.terminalGeneration = next
    }
  }
  return { gate, queuedBoundaries }
}

describe('mobile terminal query replies', () => {
  it('suppresses replay, then forwards live queries queued behind its boundary', () => {
    const messages: unknown[] = []
    const { gate, queuedBoundaries } = createQueryReplyGate((message) => messages.push(message))
    gate.setGeneration(1)
    gate.reset()
    gate.queueBoundary(1)

    gate.forward('\x1b[1;1R')
    expect(messages).toEqual([])

    expect(queuedBoundaries).toHaveLength(1)
    queuedBoundaries[0]!()
    gate.forward('\x1b[2;2R')
    expect(messages).toEqual([{ type: 'terminal-data', bytes: '\x1b[2;2R' }])
  })

  it('does not let a superseded generation reclaim reply authority', () => {
    const messages: unknown[] = []
    const { gate, queuedBoundaries } = createQueryReplyGate((message) => messages.push(message))
    gate.setGeneration(1)
    gate.queueBoundary(1)
    gate.setGeneration(2)
    gate.reset()

    expect(queuedBoundaries).toHaveLength(1)
    queuedBoundaries[0]!()
    gate.forward('\x1b[1;1R')
    expect(messages).toEqual([])
  })

  it('restores reply authority when clear discards the replay boundary', () => {
    const messages: unknown[] = []
    const { gate, queuedBoundaries } = createQueryReplyGate((message) => messages.push(message))
    gate.setGeneration(1)
    gate.reset()
    gate.queueBoundary(1)

    expect(queuedBoundaries).toHaveLength(1)
    gate.clear()
    queuedBoundaries[0]!()
    gate.forward('\x1b[3;4R')

    expect(messages).toEqual([{ type: 'terminal-data', bytes: '\x1b[3;4R' }])
  })
})
