import { describe, expect, it } from 'vitest'
import { terminalOrphanExecutionOwnersEqual } from './terminal-orphan-owner'

describe('terminal orphan execution owner', () => {
  it('requires exact SSH host ownership', () => {
    expect(
      terminalOrphanExecutionOwnersEqual(
        { connectionId: 'ssh-a', wslDistro: null },
        { connectionId: 'ssh-b', wslDistro: null }
      )
    ).toBe(false)
    expect(
      terminalOrphanExecutionOwnersEqual(
        { connectionId: 'ssh-a', wslDistro: null },
        { connectionId: 'ssh-a' }
      )
    ).toBe(true)
  })

  it('matches WSL distro case-insensitively but never crosses native or another distro', () => {
    const expected = { connectionId: null, wslDistro: 'Ubuntu' }
    expect(
      terminalOrphanExecutionOwnersEqual(expected, {
        connectionId: null,
        wslDistro: 'ubuntu'
      })
    ).toBe(true)
    expect(
      terminalOrphanExecutionOwnersEqual(expected, { connectionId: null, wslDistro: null })
    ).toBe(false)
    expect(
      terminalOrphanExecutionOwnersEqual(expected, {
        connectionId: null,
        wslDistro: 'Debian'
      })
    ).toBe(false)
    expect(terminalOrphanExecutionOwnersEqual(expected, { connectionId: null })).toBe(false)
  })
})
