import { describe, expect, it } from 'vitest'
import { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { turnActivityOperation } from './structured-agent-session-turn-activity-operation'

function queue(pauseQueuedOperations: number) {
  return new StructuredAgentSessionSinkQueue({
    watermarks: {
      pauseQueuedBytes: 1_000_000,
      maxQueuedBytes: 1_000_000,
      lowQueuedBytes: 0,
      pauseQueuedOperations,
      maxQueuedOperations: 1,
      lowQueuedOperations: 0,
      maxLifecycleQueuedBytes: 1_000_000,
      maxLifecycleQueuedOperations: 10
    }
  })
}

const ordinary = { bytes: 10, run: () => {} }
const OPEN = { turnId: 'turn-1', text: '', reasoning: { session: true, subagents: [] } }

describe('the live activity op in a full queue', () => {
  it('is admitted past the ordinary budget without itself declaring backpressure', () => {
    const full = queue(10)
    expect(full.submit(ordinary)).toEqual({ accepted: true })
    expect(full.submit(ordinary)).toEqual({ accepted: false, reason: 'backpressure' })
    const unpaused = queue(10)
    unpaused.submit(ordinary)
    expect(unpaused.submit(turnActivityOperation(OPEN))).toEqual({ accepted: true })
    expect(unpaused.state()).toMatchObject({ queuedOperations: 2, backpressured: false })
  })

  it('still counts toward the pause watermark, so reading pauses', () => {
    const pausing = queue(2)
    pausing.submit(ordinary)
    pausing.submit(turnActivityOperation(OPEN))
    expect(pausing.state()).toMatchObject({ queuedOperations: 2, backpressured: true })
  })

  it('is refused once the queue is closed', () => {
    const closed = queue(10)
    closed.close()
    expect(closed.submit(turnActivityOperation(null))).toEqual({
      accepted: false,
      reason: 'closed'
    })
  })
})
