// A paired desktop's one link to its host through the real Relay path: RelayE2eeLink's relay-auth
// and hello with a stand-in cell (the real splice limits), the host's CloudRelayTransport data
// sockets, E2EE token auth that carries the desktop's capabilities, then a resume credential.
// Bursts and a JSON stream share the link, survive a cut (redialed on the resume credential), and
// no frame reaches the wrong stream.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBurst, runningBursts } from '../testing/one-link-burst-streams.test-fixtures'
import {
  RELAY_TEST_INVITE as INVITE,
  startHostOverRelay
} from '../testing/relay-runtime-host.test-fixtures'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  runningBursts.clear()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

describe('one link per host over Relay (RelayE2eeLink)', () => {
  it(
    'pairs on the invite, keeps a resume credential, and resumes every stream after a cut',
    async () => {
      const { cell, connection, link, entry } = await startHostOverRelay(cleanups)
      expect((await link.request('status.get', { probe: true }, 15_000)).ok).toBe(true)
      expect(entry()?.resume?.version).toBe(1)
      expect(cell.credentials).toEqual([INVITE])

      // Binary channels need the desktop's capabilities on its Relay token auth.
      const streams = await Promise.all([1, 2].map((tag) => openBurst(connection, tag, cleanups)))
      let tickCount = 0
      await link.subscribe('test.ticks', null, 10_000, {
        onResponse: () => {
          tickCount += 1
        },
        onError: () => {}
      })
      await vi.waitFor(() => expect(streams.every((s) => s.frames > 50)).toBe(true), {
        timeout: 20_000
      })

      const before = streams.map((s) => s.frames)
      const ticksBefore = tickCount
      cell.cut()
      await vi.waitFor(
        () => {
          expect(streams.every((s, i) => s.frames > before[i] + 50)).toBe(true)
          expect(tickCount).toBeGreaterThan(ticksBefore + 5)
        },
        { timeout: 30_000 }
      )
      // The redial used the resume credential, not the spent invite.
      expect(cell.credentials).toHaveLength(2)
      expect(cell.credentials[1]).toBe(entry()?.resume?.token)
      expect(streams.map((s) => s.wrong)).toEqual([0, 0])
      expect(streams.map((s) => s.ends)).toEqual([1, 1])
      expect([...runningBursts.entries()].sort()).toEqual([
        [1, 1],
        [2, 1]
      ])
      expect(cell.limitCloses).toEqual([])
      for (const stream of streams) {
        stream.close()
      }
    },
    // A real host through a stand-in cell: pairing, credential install, a cut and a resumed redial.
    90_000
  )
})
