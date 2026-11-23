import { describe, expect, it } from 'vitest'
import {
  CODEX_SHARED_SERVER_BACKLOG_BYTES,
  CodexSharedServerBacklog
} from './codex-shared-server-backlog'

function countedLease(reading: boolean, visits: { count: number }) {
  return {
    shed: () => {},
    get reading() {
      visits.count += 1
      return reading
    },
    get waiting() {
      visits.count += 1
      return false
    }
  }
}

describe('shared Codex server backlog', () => {
  it.each([100, 1_000])(
    'checks a bounded number of chats per queued frame with %i chats',
    (chats) => {
      const visits = { count: 0 }
      const paused = Array.from({ length: chats }, () => countedLease(false, visits))
      // The one chat still reading comes last, so a walk from the start visits every paused one.
      const leases = new Set([...paused, countedLease(true, visits)])
      const backlog = new CodexSharedServerBacklog(
        () => ({ pauseReading: () => {}, resumeReading: () => {} }),
        leases
      )
      const frames = 20_000
      for (let frame = 0; frame < frames; frame += 1) {
        backlog.change(paused[0]!, 1024)
      }
      // Walking every chat per frame would be frames x chats (2 million at 100 chats).
      expect(visits.count).toBeLessThanOrEqual(3 * frames + 3 * (chats + 1))
    }
  )

  it.each([100, 1_000])(
    'replays an over-budget backlog checking the chats once per drain batch with %i chats',
    async (chats) => {
      const visits = { count: 0 }
      const paused = Array.from({ length: chats }, () => countedLease(false, visits))
      const leases = new Set([...paused, countedLease(true, visits)])
      const backlog = new CodexSharedServerBacklog(
        () => ({ pauseReading: () => {}, resumeReading: () => {} }),
        leases
      )
      const frameBytes = 2048
      const frames = CODEX_SHARED_SERVER_BACKLOG_BYTES / frameBytes + 1
      for (let frame = 0; frame < frames; frame += 1) {
        backlog.change(paused[0]!, frameBytes)
      }
      await Promise.resolve()
      visits.count = 0
      // A drain replays 64 KiB per task; nobody waits, so each batch may walk the chats once.
      const perBatch = (64 * 1024) / frameBytes
      let batches = 0
      for (let frame = 0; frame < frames; frame += 1) {
        backlog.change(paused[0]!, -frameBytes)
        if ((frame + 1) % perBatch === 0) {
          batches += 1
          await Promise.resolve()
        }
      }
      // Walking every chat per drained frame would be about 8 million visits at 1,000 chats.
      expect(visits.count).toBeLessThanOrEqual(4 * frames + 2 * (batches + 1) * (chats + 1))
    }
  )
})
