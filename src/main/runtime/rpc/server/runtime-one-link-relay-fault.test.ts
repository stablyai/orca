// One link per host through a stand-in Relay cell with the cell's real limits: calls, JSON streams
// and several credit-windowed binary streams share one socket, survive a cut mid-burst and a slow
// client, and no frame ever reaches the wrong stream. A cut ends each binary stream, as its own
// socket's close did, and its owner reopens it; JSON streams replay on the new socket.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { defineMethod } from '../core'
import { startOneLinkHostBehindCell } from '../testing/one-link-host-behind-cell'
import {
  burst,
  openBurst,
  runningBursts,
  ticks
} from '../testing/one-link-burst-streams.test-fixtures'

const big = defineMethod({
  name: 'test.big',
  permission: 'workspace',
  share: 'not-shared',
  params: null,
  handler: async () => ({ text: 'x'.repeat(3 * 1024 * 1024) })
})

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  runningBursts.clear()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

const startHostBehindCell = () => startOneLinkHostBehindCell([burst, ticks, big], cleanups)

describe('one link per host through a Relay cell', () => {
  it(
    'carries calls, streams and binary on one socket, and resumes all of them after a cut',
    async () => {
      const { server, cell, connection, link } = await startHostBehindCell()
      expect((await link.request('status.get', { probe: true }, 10_000)).ok).toBe(true)
      const streams = await Promise.all(
        [1, 2, 3].map((tag) => openBurst(connection, tag, cleanups))
      )
      let tickCount = 0
      await link.subscribe('test.ticks', null, 10_000, {
        onResponse: () => {
          tickCount += 1
        },
        onError: () => {}
      })
      // A one-shot call and a 3 MiB reply ride the same link while the bursts run.
      expect(
        (await sendRemoteRuntimeRequestOnSocket(connection, 'status.get', undefined, 10_000)).ok
      ).toBe(true)
      expect((await link.request('test.big', null, 20_000)).ok).toBe(true)
      await vi.waitFor(() => expect(streams.every((s) => s.frames > 50)).toBe(true), {
        timeout: 20_000
      })
      expect(server.readClientActivity().openConnections).toBeLessThanOrEqual(1)

      // Cut mid-burst: every binary stream ends once and its owner reopens it on the new link, with
      // only its own frames; the JSON stream replays by itself.
      const before = streams.map((s) => s.frames)
      const ticksBefore = tickCount
      cell.cut()
      await vi.waitFor(
        () => {
          expect(streams.every((s, i) => s.frames > before[i] + 50)).toBe(true)
          expect(tickCount).toBeGreaterThan(ticksBefore + 5)
        },
        { timeout: 20_000 }
      )
      expect((await link.request('status.get', { probe: true }, 10_000)).ok).toBe(true)
      expect(streams.map((s) => s.wrong)).toEqual([0, 0, 0])
      expect(streams.map((s) => s.ends)).toEqual([1, 1, 1])
      expect(cell.limitCloses).toEqual([])

      // The cut ended the old bursts on the host too; exactly one of each runs on the new link.
      expect([...runningBursts.entries()].sort()).toEqual([
        [1, 1],
        [2, 1],
        [3, 1]
      ])

      // A closed stream ends on the host; the others keep flowing.
      streams[0].close()
      await vi.waitFor(() => expect(runningBursts.get(1)).toBe(0), { timeout: 10_000 })
      const afterClose = streams.map((s) => s.frames)
      await vi.waitFor(
        () =>
          expect(
            streams[1].frames > afterClose[1] + 20 && streams[2].frames > afterClose[2] + 20
          ).toBe(true),
        { timeout: 20_000 }
      )
    },
    // A real host through a cell: a cut and reconnect with three bursts take several seconds.
    90_000
  )

  it(
    'rides out a slow client without tripping the cell, then catches up',
    async () => {
      const { cell, connection, link } = await startHostBehindCell()
      const streams = await Promise.all([1, 2].map((tag) => openBurst(connection, tag, cleanups)))
      await vi.waitFor(() => expect(streams.every((s) => s.frames > 20)).toBe(true), {
        timeout: 20_000
      })
      cell.stallClient(3_000)
      // ast-grep-ignore: test-no-real-time-wait -- the stall runs on real time, against the cell's real wedge timer.
      await new Promise((resolve) => setTimeout(resolve, 3_500))
      const before = streams.map((s) => s.frames)
      await vi.waitFor(
        () => expect(streams.every((s, i) => s.frames > before[i] + 50)).toBe(true),
        {
          timeout: 20_000
        }
      )
      expect(cell.limitCloses).toEqual([])
      expect(streams.map((s) => s.wrong)).toEqual([0, 0])
      expect(streams.map((s) => s.ends)).toEqual([0, 0])
      expect(link.getDiagnostics().reconnectAttempt).toBe(0)
    },
    // A real 3 s client stall, then catching up through the cell.
    60_000
  )
})
