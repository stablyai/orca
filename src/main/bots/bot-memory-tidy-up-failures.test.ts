import { describe, expect, it } from 'vitest'
import type { LookAroundRun } from './bot-background-run-history'
import { tidyUpFailureIsQuiet, tidyUpTurnedOff } from './bot-memory-tidy-up-failures'

const SINCE = 1_000
const failed = (at: number, error: string, alerted = false): LookAroundRun => ({
  sessionId: `s${at}`,
  startedAt: at,
  endedAt: at + 1,
  error,
  ...(alerted ? { alerted: true as const } : {})
})
// Ten failures in a row that turned it off, before the owner turned it back on at SINCE.
const oldStreak = Array.from({ length: 10 }, (_, at) => failed(at * 10, 'old', at === 0))

describe('nightly memory tidy-up failures after it is turned back on', () => {
  it('reports a later turn-off by the owner as theirs, not as Orca turning it off', () => {
    const runs = [...oldStreak, failed(SINCE + 10, 'new'), failed(SINCE + 20, 'new')]
    expect(tidyUpTurnedOff({ runs }, { tidyUp: { on: false, since: SINCE } })).toBeNull()
  })

  it('reports Orca turning it off once a new streak reaches the limit', () => {
    const runs = [...oldStreak, ...oldStreak.map((run) => failed(SINCE + run.startedAt, 'new'))]
    expect(tidyUpTurnedOff({ runs }, { tidyUp: { on: false, since: SINCE } })).toBe('new')
  })

  it("quiets a new streak's later failures once its first one alerted", () => {
    const current: LookAroundRun = { sessionId: 'now', startedAt: SINCE + 20 }
    const runs = [...oldStreak, failed(SINCE + 10, 'new', true), current]
    expect(tidyUpFailureIsQuiet({ runs }, { tidyUp: { on: true, since: SINCE } }, 'now')).toBe(true)
  })
})
