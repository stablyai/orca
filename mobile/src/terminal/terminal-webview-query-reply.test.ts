import { describe, expect, it } from 'vitest'
import { createTerminalDocumentScope } from './document/document-scope'
import {
  enqueueTerminalDataReplyBoundary,
  forwardTerminalDataReply,
  resetTerminalDataReplyAuthority,
  resumeTerminalDataReplyAuthority
} from './document/query-reply'

type QueryReplyGate = {
  forward: (data: string) => void
  queueBoundary: (generation: number) => void
  reset: () => void
  resume: () => void
  setGeneration: (generation: number) => void
}

/**
 * The gate over a scope the case owns.
 *
 * The module is imported and handed a scope, so the two things the gate reaches outside itself are
 * seam fields: the notify goes to `postToHost`, and the write-queue boundary the gate enqueues is
 * read off the scope's own queue rather than intercepted.
 */
function createQueryReplyGate(notify: (message: unknown) => void): {
  gate: QueryReplyGate
  queuedBoundaries: Array<() => void>
} {
  const queuedBoundaries: Array<() => void> = []
  const scope = createTerminalDocumentScope({ postToHost: notify })
  const gate: QueryReplyGate = {
    forward: (data) => forwardTerminalDataReply(scope, data),
    queueBoundary: (generation) => {
      enqueueTerminalDataReplyBoundary(scope, generation)
      // The boundary the gate enqueued, taken off the document's own queue: the cases run it to
      // stand for the replay draining.
      const queued = scope.writeQueue[scope.writeQueue.length - 1]
      if (typeof queued === 'function') {
        queuedBoundaries.push(queued)
      }
    },
    reset: () => resetTerminalDataReplyAuthority(scope),
    resume: () => resumeTerminalDataReplyAuthority(scope),
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

    queuedBoundaries[0]?.()
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

    queuedBoundaries[0]?.()
    gate.forward('\x1b[1;1R')
    expect(messages).toEqual([])
  })

  it('restores reply authority when clear discards the replay boundary', () => {
    const messages: unknown[] = []
    const { gate, queuedBoundaries } = createQueryReplyGate((message) => messages.push(message))
    gate.setGeneration(1)
    gate.reset()
    gate.queueBoundary(1)

    // A clear drops all queued writes, including the replay boundary.
    queuedBoundaries.length = 0
    gate.resume()
    gate.forward('\x1b[3;4R')

    expect(messages).toEqual([{ type: 'terminal-data', bytes: '\x1b[3;4R' }])
  })
})
