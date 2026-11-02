import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'

import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'

function createSettings(
  overrides: Partial<
    Pick<GlobalSettings, 'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'>
  > = {}
): Pick<GlobalSettings, 'activeClaudeManagedAccountId' | 'activeClaudeManagedAccountIdsByRuntime'> {
  return {
    activeClaudeManagedAccountId: null,
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} },
    ...overrides
  }
}

describe('Claude runtime account selection', () => {
  it('reads legacy distro spelling without changing the selection or launch target', () => {
    const settings = createSettings({
      activeClaudeManagedAccountIdsByRuntime: {
        host: 'host-account',
        wsl: { Ubuntu: 'wsl-account', Debian: 'debian-account' }
      }
    })
    for (const wslDistro of ['Ubuntu', 'ubuntu', ' UBUNTU ']) {
      expect(getSelectedClaudeAccountIdForTarget(settings, { runtime: 'wsl', wslDistro })).toBe(
        'wsl-account'
      )
    }
    expect(
      getSelectedClaudeAccountIdForTarget(settings, { runtime: 'wsl', wslDistro: 'Fedora' })
    ).toBeNull()
    expect(settings.activeClaudeManagedAccountIdsByRuntime?.wsl).toEqual({
      Ubuntu: 'wsl-account',
      Debian: 'debian-account'
    })
  })

  it('keeps exact legacy spellings and does not choose between conflicting aliases', () => {
    for (const wsl of [
      { Ubuntu: 'a', ubuntu: 'b' },
      { Ubuntu: 'a', ubuntu: null }
    ]) {
      const settings = createSettings({
        activeClaudeManagedAccountIdsByRuntime: { host: null, wsl }
      })
      const lookup = (wslDistro: string) =>
        getSelectedClaudeAccountIdForTarget(settings, { runtime: 'wsl', wslDistro })
      expect(lookup('Ubuntu')).toBe('a')
      expect(lookup('ubuntu')).toBe(wsl.ubuntu)
      expect(lookup('UBUNTU')).toBeNull()
    }
  })
})
