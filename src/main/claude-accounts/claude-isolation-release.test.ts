import { describe, expect, it, vi } from 'vitest'
import { releaseManagedClaudeSelections } from './claude-isolation-release'

function deps(overrides: { materializedAfter?: boolean } = {}) {
  return {
    getSettings: () => ({
      activeClaudeManagedAccountId: 'host-account',
      activeClaudeManagedAccountIdsByRuntime: {
        host: 'host-account',
        wsl: { Ubuntu: 'wsl-account', Debian: null }
      }
    }),
    deselect: vi.fn(async () => {}),
    hasMaterializedManagedLogin: vi.fn(() => overrides.materializedAfter ?? false)
  }
}

describe('releaseManagedClaudeSelections', () => {
  it('deselects host and every WSL distro that has a managed account', async () => {
    const release = deps()

    await releaseManagedClaudeSelections(release)

    expect(release.deselect).toHaveBeenCalledWith({ runtime: 'host' })
    expect(release.deselect).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(release.deselect).toHaveBeenCalledTimes(2)
  })

  it('fails when the managed login is still materialized after deselecting', async () => {
    // Simulates a sync that silently skipped its restore.
    const release = deps({ materializedAfter: true })

    await expect(releaseManagedClaudeSelections(release)).rejects.toThrow('still materialized')
  })
})
