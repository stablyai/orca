import { describe, expect, it } from 'vitest'
import { parsePtyStatus, stripPtyControlSequences } from './agy-pty-status-parser'

describe('agy-pty-status-parser', () => {
  it('parses multi-line Antigravity five hour and weekly limit output', () => {
    const rawOutput = `
    Five hour limit
    ████░░░░░░░░░░░ 19% used
    Refreshes in 4h 12m

    Weekly limit
    ███████████████ 100% remaining
    Refreshes Jul 30, 3:00 PM
    `

    const clean = stripPtyControlSequences(rawOutput)
    const { session, weekly } = parsePtyStatus(clean)

    expect(session).toEqual({
      usedPercent: 19,
      windowMinutes: 300,
      resetsAt: expect.any(Number),
      resetDescription: '4h 12m'
    })

    expect(weekly).toEqual({
      usedPercent: 0,
      windowMinutes: 10080,
      resetsAt: expect.any(Number),
      resetDescription: 'Jul 30, 3:00 PM'
    })
  })

  it('strips ANSI and PTY control sequences correctly', () => {
    const ansiInput = '\x1b[31mFive hour limit\x1b[0m\r\n\x1b[32m19% used\x1b[0m'
    const clean = stripPtyControlSequences(ansiInput)
    expect(clean).toBe('Five hour limit\r\n19% used')
  })
})
