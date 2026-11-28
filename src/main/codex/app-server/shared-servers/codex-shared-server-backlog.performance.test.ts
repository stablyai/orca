import { describe, expect, it } from 'vitest'
import { CodexSharedServerBacklog } from './codex-shared-server-backlog'

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

  it('keeps its reading chat across repeated fill-and-drain cycles', () => {
    const visits = { count: 0 }
    const chats = 1_000
    const paused = Array.from({ length: chats }, () => countedLease(false, visits))
    const leases = new Set([...paused, countedLease(true, visits)])
    const backlog = new CodexSharedServerBacklog(
      () => ({ pauseReading: () => {}, resumeReading: () => {} }),
      leases
    )
    const cycles = 1_000
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      backlog.change(paused[0]!, 1024)
      backlog.change(paused[0]!, -1024)
    }
    // Forgetting the reading chat whenever the backlog empties would walk every chat per cycle.
    expect(visits.count).toBeLessThanOrEqual(6 * cycles + 3 * (chats + 1))
  })
})
