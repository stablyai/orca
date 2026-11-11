import { describe, expect, it } from 'vitest'
import {
  formatWorktreePsTerminalFields,
  projectWorktreePsTerminalVerdict
} from './worktree-ps-terminal-verdict'

describe('worktree ps terminal verdict', () => {
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

  it('reports unverifiable for an idle row from a host that predates the count', () => {
    const row = { liveTerminalCount: 0, hasAttachedPty: false }
    expect(formatWorktreePsTerminalFields(row)).toBe('live:unverifiable  pty:unverifiable')
    expect(projectWorktreePsTerminalVerdict(row)).toEqual({
      ...row,
      terminalVerdict: 'unverifiable'
    })
  })
})
