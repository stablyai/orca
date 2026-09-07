import { describe, expect, it } from 'vitest'
import { drainTerminalMultiplexRoundRobin } from './terminal-multiplex-round-robin'

describe('terminal multiplex round-robin drain', () => {
  it('admits a later interactive stream before older bulk queues refill the window', () => {
    const streams = Array.from({ length: 8 }, (_, index) => ({
      streamId: index + 1,
      pendingChunks: index === 7 ? 1 : 8
    }))
    const order: number[] = []
    let remainingSlots = 8

    const cursor = drainTerminalMultiplexRoundRobin({
      streams,
      cursorStreamId: null,
      canContinue: () => remainingSlots > 0,
      drainOne: (stream) => {
        if (stream.pendingChunks === 0) {
          return false
        }
        stream.pendingChunks -= 1
        remainingSlots -= 1
        order.push(stream.streamId)
        return true
      }
    })

    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(cursor).toBe(8)
  })

  it('resumes after the previous sender on the next release', () => {
    const streams = [1, 2, 3].map((streamId) => ({ streamId, pendingChunks: 2 }))
    let slots = 2
    const firstOrder: number[] = []
    const cursor = drainTerminalMultiplexRoundRobin({
      streams,
      cursorStreamId: null,
      canContinue: () => slots > 0,
      drainOne: (stream) => {
        stream.pendingChunks -= 1
        slots -= 1
        firstOrder.push(stream.streamId)
        return true
      }
    })
    slots = 2
    const secondOrder: number[] = []
    drainTerminalMultiplexRoundRobin({
      streams,
      cursorStreamId: cursor,
      canContinue: () => slots > 0,
      drainOne: (stream) => {
        if (stream.pendingChunks === 0) {
          return false
        }
        stream.pendingChunks -= 1
        slots -= 1
        secondOrder.push(stream.streamId)
        return true
      }
    })

    expect(firstOrder).toEqual([1, 2])
    expect(secondOrder).toEqual([3, 1])
  })
})
