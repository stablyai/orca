import { describe, expect, it, vi } from 'vitest'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { reconcileRetainedCodexHookHomes } from './retained-codex-hook-state'

function status(state: 'installed' | 'not_installed' | 'error'): AgentHookInstallStatus {
  return {
    agent: 'codex',
    state,
    configPath: '/runtime/hooks.json',
    managedHooksPresent: state === 'installed',
    detail: state === 'error' ? 'failed' : null
  }
}

describe('retained Codex hook state', () => {
  it("refreshes each retained home's user-hook mirror, which carries no Orca entry", async () => {
    const refreshRuntimeUserHooks = vi.fn(() => status('not_installed'))

    await reconcileRetainedCodexHookHomes({
      hookService: { refreshRuntimeUserHooks },
      runtimeHomePaths: ['/orca/shared-home', '/orca/account-home']
    })

    expect(refreshRuntimeUserHooks).toHaveBeenCalledTimes(2)
    expect(refreshRuntimeUserHooks).toHaveBeenNthCalledWith(1, '/orca/shared-home')
    expect(refreshRuntimeUserHooks).toHaveBeenNthCalledWith(2, '/orca/account-home')
  })

  it('keeps going past a home whose refresh fails', async () => {
    const refreshRuntimeUserHooks = vi
      .fn()
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValueOnce(status('not_installed'))

    await reconcileRetainedCodexHookHomes({
      hookService: { refreshRuntimeUserHooks },
      runtimeHomePaths: ['/orca/broken-home', '/orca/account-home']
    })

    expect(refreshRuntimeUserHooks).toHaveBeenLastCalledWith('/orca/account-home')
  })
})
