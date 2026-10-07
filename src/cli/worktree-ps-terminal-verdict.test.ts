import { describe, expect, it } from 'vitest'
import {
  formatWorktreePsTerminalFields,
  projectWorktreePsTerminalVerdict
} from './worktree-ps-terminal-verdict'

describe('worktree ps terminal verdict', () => {
  it('prints counts for a reachable host', () => {
    const row = { liveTerminalCount: 2, hasAttachedPty: true, unverifiableTerminalCount: 0 }
    expect(formatWorktreePsTerminalFields(row)).toBe('live:2  pty:yes')
    expect(projectWorktreePsTerminalVerdict(row)).toEqual({ ...row, terminalVerdict: 'live' })
  })

  it('prints unverifiable, never zero or no, for an unreachable host', () => {
    const row = { liveTerminalCount: 0, hasAttachedPty: false, unverifiableTerminalCount: 1 }
    expect(formatWorktreePsTerminalFields(row)).toBe('live:unverifiable  pty:unverifiable')
    expect(projectWorktreePsTerminalVerdict(row), 'count fields keep their JSON types').toEqual({
      ...row,
      terminalVerdict: 'unverifiable'
    })
  })

  it('keeps verified terminals alongside unverifiable ones', () => {
    const row = { liveTerminalCount: 1, hasAttachedPty: true, unverifiableTerminalCount: 2 }
    expect(formatWorktreePsTerminalFields(row)).toBe('live:1+2 unverifiable  pty:yes')
    expect(
      formatWorktreePsTerminalFields({ ...row, hasAttachedPty: false }),
      'an unverifiable terminal may hold the pty'
    ).toBe('live:1+2 unverifiable  pty:unverifiable')
    expect(projectWorktreePsTerminalVerdict(row)).toEqual({ ...row, terminalVerdict: 'live' })
  })

  it('reports none, not exited, for a row with no terminals', () => {
    const row = { liveTerminalCount: 0, hasAttachedPty: false, unverifiableTerminalCount: 0 }
    expect(formatWorktreePsTerminalFields(row)).toBe('live:0  pty:no')
    expect(projectWorktreePsTerminalVerdict(row)).toEqual({ ...row, terminalVerdict: 'none' })
  })

  it('reports unverifiable for an idle row from a host that predates the count', () => {
    const row = { liveTerminalCount: 0, hasAttachedPty: false }
    expect(formatWorktreePsTerminalFields(row)).toBe('live:unverifiable  pty:unverifiable')
    expect(projectWorktreePsTerminalVerdict(row)).toEqual({
      ...row,
      terminalVerdict: 'unverifiable'
    })
  })
})
