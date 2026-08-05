import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RelayDispatcher,
  type LegacyProjectionRole,
  type RelayClientSinkOptions,
  type SinkWriteSettlement
} from './dispatcher'
import { DISPATCHER_CONTROL_QUEUE_MAX_FRAMES } from './dispatcher-writer-admission'

type SlowClient = {
  frames: Buffer[]
  closes: number
  options: RelayClientSinkOptions
  write: (data: Buffer) => boolean
  drain: () => void
}

// Why: a sink that refuses every write until told otherwise reproduces the ~268ms link in #12041, where
// full-screen redraws outrun the client's drain rate and saturate the bounded producer lane.
function makeStallingClient(highWaterMark: number, drainable = false): SlowClient {
  let stalled = true
  let drainWaiter: (() => void) | null = null
  const client: SlowClient = {
    frames: [],
    closes: 0,
    write: (data: Buffer) => {
      client.frames.push(Buffer.from(data))
      return !stalled
    },
    options: {
      writableHighWaterMark: () => highWaterMark,
      writableLength: () => 0,
      close: () => {
        client.closes++
      },
      ...(drainable
        ? {
            waitWriteDrain: (callback: () => void) => {
              drainWaiter = callback
            }
          }
        : {})
    },
    drain: () => {
      stalled = false
      const waiter = drainWaiter
      drainWaiter = null
      waiter?.()
    }
  }
  return client
}

function ptyDataFrameCount(frames: Buffer[]): number {
  return frames.filter((frame) => {
    const length = frame.readUInt32BE(9)
    const message = JSON.parse(frame.subarray(13, 13 + length).toString('utf-8')) as {
      method?: string
    }
    return message.method === 'pty.data'
  }).length
}

// Fills the 2 MiB producer lane to the byte, so even a bare pty.exit no longer fits.
function fillProducerQueue(dispatcher: RelayDispatcher, clientId: number): void {
  for (const size of [40_000, 32]) {
    while (
      dispatcher.tryNotifyPtyDataToClient(
        clientId,
        { id: 'pty-1', data: 'x'.repeat(size) },
        () => {}
      )
    ) {
      /* saturate */
    }
  }
}

function roles(
  byId: Record<number, LegacyProjectionRole>
): (clientId: number) => LegacyProjectionRole {
  return (clientId) => byId[clientId] ?? 'skip'
}

describe('RelayDispatcher slow-client PTY projection', () => {
  it('tryNotifyPtyData applies backpressure without closing the client', () => {
    const primary = makeStallingClient(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      let accepted = 0
      let rejected = 0
      for (let index = 0; index < 200; index++) {
        if (dispatcher.tryNotifyPtyData({ id: 'pty-1', data: 'x'.repeat(40_000) })) {
          accepted++
        } else {
          rejected++
        }
      }
      expect(accepted).toBeGreaterThan(0)
      expect(rejected).toBeGreaterThan(0)
      expect(primary.closes).toBe(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('rejects a projected pty.data frame instead of closing an owner that cannot drain', () => {
    const primary = makeStallingClient(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const primaryId = dispatcher.activeClientIds()[0]
      fillProducerQueue(dispatcher, primaryId)

      const projected = dispatcher.projectPtyDataToLegacyClients(roles({ [primaryId]: 'owner' }), {
        id: 'pty-1',
        data: 'y'.repeat(40_000)
      })

      // A false return is what makes pty-handler pause the PTY and republish the span after drain.
      expect(projected).toBe(false)
      expect(primary.closes).toBe(0)
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })

  it('closes a saturated mirror instead of pausing the PTY for every other viewer', () => {
    const owner = makeStallingClient(65536)
    owner.drain()
    const mirror = makeStallingClient(65536)
    const dispatcher = new RelayDispatcher(owner.write, owner.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const ownerId = dispatcher.activeClientIds()[0]
      const mirrorId = dispatcher.attachClient(mirror.write, mirror.options)
      fillProducerQueue(dispatcher, mirrorId)
      const mirrorBefore = ptyDataFrameCount(mirror.frames)

      const projected = dispatcher.projectPtyDataToLegacyClients(
        roles({ [ownerId]: 'owner', [mirrorId]: 'mirror' }),
        { id: 'pty-1', data: 'y'.repeat(40_000) }
      )

      // A bystander mirror (agent hook, orca CLI, second window) must not gate the native PTY.
      expect(projected).toBe(true)
      expect(ptyDataFrameCount(owner.frames)).toBe(1)
      expect(ptyDataFrameCount(mirror.frames)).toBe(mirrorBefore)
      expect(mirror.closes).toBe(1)
      expect(owner.closes).toBe(0)
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })

  it('releases the relay-wide legacy gate when a mirror can never drain', () => {
    const owner = makeStallingClient(65536)
    owner.drain()
    const mirror = makeStallingClient(65536)
    const dispatcher = new RelayDispatcher(owner.write, owner.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const ownerId = dispatcher.activeClientIds()[0]
      const mirrorId = dispatcher.attachClient(mirror.write, mirror.options)
      fillProducerQueue(dispatcher, mirrorId)
      // Its retained leases sit above the relay-wide low-water mark, so every paused PTY is gated.
      expect(dispatcher.legacyRetentionBelowLowWater).toBe(false)

      const roleOf = roles({ [ownerId]: 'owner', [mirrorId]: 'mirror' })
      dispatcher.projectPtyDataToLegacyClients(roleOf, { id: 'pty-1', data: 'y'.repeat(40_000) })

      // PtyHandler.maybeResumePtyOutput reads this gate; if a shed mirror keeps it false with nothing
      // left to evict it, every paused PTY on the host stays paused forever.
      expect(mirror.closes).toBe(1)
      expect(dispatcher.legacyRetentionBelowLowWater).toBe(true)
      expect(owner.closes).toBe(0)
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })

  it('sheds a projected frame no owner sink can ever admit rather than wedging the PTY', () => {
    const primary = makeStallingClient(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const primaryId = dispatcher.activeClientIds()[0]
      // Larger than producerFrameCapacity (49152B), so retrying it forever would stall the PTY.
      const projected = dispatcher.projectPtyDataToLegacyClients(roles({ [primaryId]: 'owner' }), {
        id: 'pty-1',
        data: 'y'.repeat(60_000)
      })

      expect(projected).toBe(true)
      expect(primary.closes).toBe(0)
      const drops = stderr.mock.calls.filter((call) =>
        /producer frame capacity/.test(String(call[0]))
      )
      expect(drops).toHaveLength(1)
      expect(String(drops[0][0])).toMatch(
        /^\[relay\] Dropped pty\.data \(\d+B > producer frame capacity 49152B\)\n$/
      )
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })

  it('delivers a rejected projection exactly once to every mirror after the owner drains', () => {
    const owner = makeStallingClient(65536, true)
    const mirror = makeStallingClient(65536, true)
    mirror.drain()
    const dispatcher = new RelayDispatcher(owner.write, owner.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const ownerId = dispatcher.activeClientIds()[0]
      const mirrorId = dispatcher.attachClient(mirror.write, mirror.options)
      fillProducerQueue(dispatcher, ownerId)
      const mirrorBefore = ptyDataFrameCount(mirror.frames)
      const roleOf = roles({ [ownerId]: 'owner', [mirrorId]: 'mirror' })

      const params = { id: 'pty-1', data: 'y'.repeat(40_000) }
      expect(dispatcher.projectPtyDataToLegacyClients(roleOf, params)).toBe(false)
      // The mirror must not get a copy the owner's retry would duplicate.
      expect(ptyDataFrameCount(mirror.frames)).toBe(mirrorBefore)

      owner.drain()
      expect(dispatcher.projectPtyDataToLegacyClients(roleOf, params)).toBe(true)
      expect(ptyDataFrameCount(mirror.frames)).toBe(mirrorBefore + 1)
      expect(owner.closes).toBe(0)
      expect(mirror.closes).toBe(0)
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })

  it('holds a projected pty.exit for retry instead of closing a saturated owner', () => {
    const primary = makeStallingClient(65536, true)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const primaryId = dispatcher.activeClientIds()[0]
      fillProducerQueue(dispatcher, primaryId)
      const roleOf = roles({ [primaryId]: 'owner' })

      const params = { id: 'pty-1', exitCode: 0 }
      expect(dispatcher.projectPtyExitToLegacyClients(roleOf, params)).toBe(false)
      expect(primary.closes).toBe(0)

      primary.drain()
      expect(dispatcher.projectPtyExitToLegacyClients(roleOf, params)).toBe(true)
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })

  it('never encodes a projection with no targets', () => {
    const primary = makeStallingClient(65536)
    primary.drain()
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      // A flow-controlled owner is excluded from the legacy projection, so "no target" is the hot path.
      let reads = 0
      const params = {
        id: 'pty-1',
        get data(): string {
          reads++
          return 'y'.repeat(40_000)
        }
      }
      const primaryId = dispatcher.activeClientIds()[0]

      expect(dispatcher.projectPtyDataToLegacyClients(roles({}), params)).toBe(true)
      expect(reads).toBe(0)

      expect(
        dispatcher.projectPtyDataToLegacyClients(roles({ [primaryId]: 'owner' }), params)
      ).toBe(true)
      expect(reads).toBeGreaterThan(0)
    } finally {
      dispatcher.dispose()
    }
  })

  it('a >1MiB response while the producer queue is full does not close the client', async () => {
    const primary = makeStallingClient(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      dispatcher.onRequest('pty.serialize', async () => ({ data: 'z'.repeat(1_500_000) }))
      fillProducerQueue(dispatcher, dispatcher.activeClientIds()[0])

      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      expect(primary.closes).toBe(0)
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })
})

describe('RelayDispatcher projection never reaps a client on a timer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never closes a peer that is merely mid-write while another target back-pressures', () => {
    vi.useFakeTimers()
    const owner = makeStallingClient(65536, true)
    const dispatcher = new RelayDispatcher(owner.write, owner.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    let midWriteCloses = 0
    try {
      const ownerId = dispatcher.activeClientIds()[0]
      const midWriteId = dispatcher.attachClient(
        (_data, settle: (result: SinkWriteSettlement) => void) => {
          // Accepted by the sink but not acknowledged yet: normal for any real socket mid-write.
          void settle
          return true
        },
        {
          supportsWriteCallback: true,
          writableHighWaterMark: () => 65536,
          writableLength: () => 0,
          close: () => {
            midWriteCloses++
          }
        }
      )
      fillProducerQueue(dispatcher, ownerId)
      const roleOf = roles({ [ownerId]: 'owner', [midWriteId]: 'mirror' })
      const params = { id: 'pty-1', data: 'y'.repeat(40_000) }

      expect(dispatcher.projectPtyDataToLegacyClients(roleOf, params)).toBe(false)
      // Just inside the 30s window an earlier revision watched, so the peer armed here would be
      // judged over ~1ms of observation.
      vi.advanceTimersByTime(29_999)
      dispatcher.tryNotifyPtyDataToClient(midWriteId, { id: 'pty-1', data: 'z' }, () => {})
      expect(dispatcher.projectPtyDataToLegacyClients(roleOf, params)).toBe(false)
      vi.advanceTimersByTime(10 * 60_000)

      // A peer with a frame merely in flight still has queue room; reaping it on a timer is exactly
      // the disconnect #12041 reported.
      expect(midWriteCloses).toBe(0)
      expect(owner.closes).toBe(0)
      expect(dispatcher.activeClientIds()).toHaveLength(2)

      owner.drain()
      expect(dispatcher.projectPtyDataToLegacyClients(roleOf, params)).toBe(true)
      expect(midWriteCloses).toBe(0)
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })
})

describe('RelayDispatcher pty.replay under a full control lane', () => {
  it('drops replay instead of killing a link that would regenerate the same replay', () => {
    const primary = makeStallingClient(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      // REPLAY_BUFFER_MAX is 100 KiB per PTY; a restored workspace replays many terminals at once.
      for (let index = 0; index < 12; index++) {
        dispatcher.notify('pty.replay', { id: `pty-${index}`, data: 'x'.repeat(100 * 1024) })
      }
      expect(primary.closes).toBe(0)
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })

  it('logs one dropped-replay line per generation however many panes are stranded', () => {
    const primary = makeStallingClient(65536)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const clientId = dispatcher.activeClientIds()[0]
      for (let index = 0; index < DISPATCHER_CONTROL_QUEUE_MAX_FRAMES; index += 1) {
        dispatcher.notifyClient(clientId, `control.${index}`)
      }
      stderr.mockClear()

      dispatcher.notify('pty.replay', { id: 'pty-1', data: 'x' })
      expect(primary.closes).toBe(0)
      expect(stderr).toHaveBeenCalledTimes(1)
      // The control lane rejected it; naming the producer bound would point at the wrong limit.
      expect(String(stderr.mock.calls[0][0])).toMatch(
        /^\[relay\] Dropped pty\.replay \(\d+B, control queue full\)\n$/
      )

      dispatcher.notify('pty.replay', { id: 'pty-2', data: 'x' })
      expect(primary.closes).toBe(0)
      expect(stderr).toHaveBeenCalledTimes(1)
    } finally {
      stderr.mockRestore()
      dispatcher.dispose()
    }
  })
})
