import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'

type TestSocket = Socket & {
  write: ReturnType<typeof vi.fn>
  writableLength: number
}

function createSocket(): TestSocket {
  return {
    destroyed: false,
    writableLength: 0,
    write: vi.fn(() => true)
  } as unknown as TestSocket
}

function createBatcher(options?: ConstructorParameters<typeof DaemonStreamDataBatcher>[1]) {
  const sockets = new Map<string, TestSocket>()
  const socketFor = (clientId: string): TestSocket => {
    let socket = sockets.get(clientId)
    if (!socket) {
      socket = createSocket()
      sockets.set(clientId, socket)
    }
    return socket
  }
  const batcher = new DaemonStreamDataBatcher(
    (clientId) => ({ streamSocket: socketFor(clientId) }),
    options
  )
  return { batcher, socketFor }
}

function pendingBatch(
  batcher: DaemonStreamDataBatcher,
  clientId = 'client-1'
): PendingStreamDataBatch {
  const pendingByClient = (
    batcher as unknown as {
      pendingByClient: Map<string, PendingStreamDataBatch>
    }
  ).pendingByClient
  const batch = pendingByClient.get(clientId)
  if (!batch) {
    throw new Error(`Missing pending batch for ${clientId}`)
  }
  return batch
}

function pendingByClient(batcher: DaemonStreamDataBatcher): Map<string, PendingStreamDataBatch> {
  return (
    batcher as unknown as {
      pendingByClient: Map<string, PendingStreamDataBatch>
    }
  ).pendingByClient
}

describe('DaemonStreamDataBatcher droppable membership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does no droppability scans for steady-state output from an existing member', () => {
    const isSessionDroppable = vi.fn(() => true)
    const { batcher } = createBatcher({ isSessionDroppable })
    const sessionCount = 100
    const chunkCount = 1_000

    for (let index = 0; index < sessionCount; index++) {
      batcher.enqueue('client-1', `session-${index}`, 'seed')
    }
    const batch = pendingBatch(batcher)
    const mapGet = vi.spyOn(batch.queuedCharsBySession, 'get')
    const mapSet = vi.spyOn(batch.queuedCharsBySession, 'set')
    const mapIterator = vi.spyOn(batch.queuedCharsBySession, Symbol.iterator)
    const mapEntries = vi.spyOn(batch.queuedCharsBySession, 'entries')
    const mapValues = vi.spyOn(batch.queuedCharsBySession, 'values')
    const mapForEach = vi.spyOn(batch.queuedCharsBySession, 'forEach')
    const membershipHas = vi.spyOn(batch.droppableQueuedSessionIds, 'has')
    isSessionDroppable.mockClear()

    for (let index = 0; index < chunkCount; index++) {
      batcher.enqueue('client-1', 'session-0', 'x')
    }

    // Legacy evaluated the producer plus all 100 queued sessions per chunk: 101,000 calls.
    expect(isSessionDroppable).toHaveBeenCalledTimes(0)
    expect(mapIterator).toHaveBeenCalledTimes(0)
    expect(mapEntries).toHaveBeenCalledTimes(0)
    expect(mapValues).toHaveBeenCalledTimes(0)
    expect(mapForEach).toHaveBeenCalledTimes(0)
    expect(mapGet).toHaveBeenCalledTimes(chunkCount)
    expect(mapSet).toHaveBeenCalledTimes(chunkCount)
    expect(membershipHas).toHaveBeenCalledTimes(chunkCount)
    expect(batcher.queuedCharsForClient('client-1')).toBe(1_400)
    expect(batch.queuedCharsBySession.get('session-0')).toBe(1_004)
    expect(batch.droppableQueuedSessionIds).toHaveLength(sessionCount)
  })

  it('evaluates a new positive session exactly once and records membership', () => {
    const isSessionDroppable = vi.fn(() => true)
    const { batcher } = createBatcher({ isSessionDroppable })

    batcher.enqueue('client-1', 'session-new', 'x')

    expect(isSessionDroppable).toHaveBeenCalledTimes(1)
    expect(isSessionDroppable).toHaveBeenCalledWith('session-new')
    expect(pendingBatch(batcher).droppableQueuedSessionIds).toEqual(new Set(['session-new']))
  })

  it('evaluates a transformed zero span without adding it and preserves growth re-trimming', () => {
    let droppable = false
    const isSessionDroppable = vi.fn(() => droppable)
    const { batcher } = createBatcher({ isSessionDroppable })
    const queued = 1_100 * 1024

    batcher.enqueue('client-1', 'session-held', 'h'.repeat(queued))
    droppable = true
    batcher.refreshSessionDroppability('session-held')
    expect(batcher.queuedCharsForClient('client-1')).toBe(queued)
    isSessionDroppable.mockClear()

    batcher.enqueue('client-1', 'session-empty', '', {
      rawLength: 9,
      transformed: true
    })

    const batch = pendingBatch(batcher)
    expect(isSessionDroppable).toHaveBeenCalledTimes(1)
    expect(batch.droppableQueuedSessionIds).toEqual(new Set(['session-held']))
    expect(batch.queuedCharsBySession.get('session-empty')).toBe(0)
    expect(batch.lastEvaluatedDroppableSessionCount).toBe(1)
    expect(batch.queuedCharsBySession.get('session-held')).toBe(512 * 1024)

    isSessionDroppable.mockClear()
    batcher.enqueue('client-1', 'session-held', 'z')
    expect(isSessionDroppable).toHaveBeenCalledTimes(0)
    expect(batch.queuedCharsBySession.get('session-held')).toBe(512 * 1024 + 1)
    expect(batch.queue.find((entry) => entry.control?.event === 'dataGap')?.control).toMatchObject({
      event: 'dataGap',
      payload: { droppedChars: queued - 512 * 1024 }
    })
  })

  it('refreshes one session across every client batch with one predicate call', () => {
    let droppable = false
    const isSessionDroppable = vi.fn(() => droppable)
    const { batcher } = createBatcher({ isSessionDroppable })

    batcher.enqueue('client-1', 'session-routed', 'a')
    batcher.enqueue('client-2', 'session-routed', 'b')
    batcher.enqueue('client-3', 'session-routed', '', { transformed: true })
    droppable = true
    isSessionDroppable.mockClear()

    batcher.refreshSessionDroppability('session-routed')

    expect(isSessionDroppable).toHaveBeenCalledTimes(1)
    expect(pendingBatch(batcher, 'client-1').droppableQueuedSessionIds).toContain('session-routed')
    expect(pendingBatch(batcher, 'client-2').droppableQueuedSessionIds).toContain('session-routed')
    expect(pendingBatch(batcher, 'client-3').droppableQueuedSessionIds).not.toContain(
      'session-routed'
    )
  })

  it('preserves queued-session Map order when growth re-trims members', () => {
    const salvageDroppedData = vi.fn((_dropped: string) => '')
    const { batcher } = createBatcher({
      isSessionDroppable: () => true,
      salvageDroppedData
    })
    const queuedPerSession = 800 * 1024

    // A zero total reserves the first Map position without joining the Set.
    batcher.enqueue('client-1', 'session-a', '', { transformed: true })
    for (const id of ['b', 'c', 'd', 'e']) {
      batcher.enqueue('client-1', `session-${id}`, id.repeat(queuedPerSession))
    }
    batcher.enqueue('client-1', 'session-a', 'a'.repeat(queuedPerSession))
    salvageDroppedData.mockClear()

    // The sixth member tightens the cap below 800 KiB. Map order is A→E,
    // while Set insertion order is B→E→A.
    batcher.enqueue('client-1', 'session-f', 'f')

    expect(
      salvageDroppedData.mock.calls
        .map(([dropped]) => dropped)
        .filter((dropped) => dropped.length > 0)
        .map((dropped) => dropped[0])
    ).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('reconciles foreground transitions without eagerly changing queued bytes', () => {
    let droppable = false
    const isSessionDroppable = vi.fn(() => droppable)
    const { batcher } = createBatcher({ isSessionDroppable })
    const initialChars = 1_100 * 1024

    batcher.enqueue('client-1', 'session-toggle', 'x'.repeat(initialChars))
    droppable = true
    batcher.refreshSessionDroppability('session-toggle')
    expect(batcher.queuedCharsForClient('client-1')).toBe(initialChars)

    isSessionDroppable.mockClear()
    batcher.enqueue('client-1', 'session-toggle', 'x')
    expect(isSessionDroppable).toHaveBeenCalledTimes(0)
    expect(pendingBatch(batcher).queuedCharsBySession.get('session-toggle')).toBe(512 * 1024)

    droppable = false
    batcher.refreshSessionDroppability('session-toggle')
    const foregroundChars = 512 * 1024 + 600 * 1024
    isSessionDroppable.mockClear()
    batcher.enqueue('client-1', 'session-toggle', 'y'.repeat(600 * 1024))
    expect(isSessionDroppable).toHaveBeenCalledTimes(0)
    expect(pendingBatch(batcher).queuedCharsBySession.get('session-toggle')).toBe(foregroundChars)

    droppable = true
    batcher.refreshSessionDroppability('session-toggle')
    expect(pendingBatch(batcher).queuedCharsBySession.get('session-toggle')).toBe(foregroundChars)
  })

  it('does not lower the last evaluated count during shrink and regrow refreshes', () => {
    const backgrounded = new Set<string>()
    const { batcher } = createBatcher({
      isSessionDroppable: (sessionId) => backgrounded.has(sessionId)
    })
    const queuedPerSession = 600 * 1024

    for (let index = 0; index < 6; index++) {
      const sessionId = `session-${index}`
      backgrounded.add(sessionId)
      batcher.enqueue('client-1', sessionId, 'x'.repeat(queuedPerSession))
    }
    const batch = pendingBatch(batcher)
    expect(batch.lastEvaluatedDroppableSessionCount).toBe(6)

    backgrounded.delete('session-0')
    batcher.refreshSessionDroppability('session-0')
    batcher.enqueue('client-1', 'session-0', 'x'.repeat(300 * 1024))
    backgrounded.add('session-0')
    batcher.refreshSessionDroppability('session-0')
    expect(batch.queuedCharsBySession.get('session-0')).toBe(900 * 1024)
    expect(batch.lastEvaluatedDroppableSessionCount).toBe(6)

    batcher.enqueue('client-1', 'session-1', 'x')
    expect(batch.queuedCharsBySession.get('session-0')).toBe(900 * 1024)
  })

  it('retains membership after a partial drain and removes it after the final drain', () => {
    const { batcher, socketFor } = createBatcher({ isSessionDroppable: () => true })
    const socket = socketFor('client-1')
    const refillCallbacks: (() => void)[] = []
    socket.write.mockImplementation((line: string, callback?: () => void) => {
      if (callback) {
        refillCallbacks.push(callback)
      } else if ((JSON.parse(String(line)) as { payload?: { data?: string } }).payload?.data) {
        socket.writableLength = 128 * 1024
      }
      return true
    })

    batcher.enqueue('client-1', 'session-drain', 'x'.repeat(128 * 1024))
    batcher.flush('client-1')

    expect(pendingBatch(batcher).queuedCharsBySession.get('session-drain')).toBe(64 * 1024)
    expect(pendingBatch(batcher).droppableQueuedSessionIds).toContain('session-drain')
    expect(refillCallbacks).toHaveLength(1)

    socket.writableLength = 0
    refillCallbacks[0]()
    expect(pendingByClient(batcher).has('client-1')).toBe(false)
  })

  it('removes only the flushed session membership during an immediate session flush', () => {
    const { batcher } = createBatcher({ isSessionDroppable: () => true })
    batcher.enqueue('client-1', 'session-flushed', 'flush-me')
    batcher.enqueue('client-1', 'session-retained', 'keep-me')

    batcher.enqueue('client-1', 'session-flushed', '', {
      flushImmediately: true
    })

    const batch = pendingBatch(batcher)
    expect(batch.queuedCharsBySession.has('session-flushed')).toBe(false)
    expect(batch.droppableQueuedSessionIds).toEqual(new Set(['session-retained']))
  })

  it('never evaluates or tracks control-only entries', () => {
    const isSessionDroppable = vi.fn(() => true)
    const { batcher } = createBatcher({ isSessionDroppable })

    batcher.enqueueControlEvent('client-1', 'session-control', {
      type: 'event',
      event: 'sessionBackgroundMarker',
      sessionId: 'session-control',
      payload: { background: true }
    })

    const batch = pendingBatch(batcher)
    expect(isSessionDroppable).toHaveBeenCalledTimes(0)
    expect(batch.queuedCharsBySession.has('session-control')).toBe(false)
    expect(batch.droppableQueuedSessionIds).toHaveLength(0)
    expect(batch.lastEvaluatedDroppableSessionCount).toBeUndefined()
  })
})
