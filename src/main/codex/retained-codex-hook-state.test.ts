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
  it('repairs Orca hooks before a retained shell can launch Codex', () => {
    const install = vi.fn(() => status('installed'))
    const refreshRuntimeUserHooks = vi.fn(() => status('not_installed'))

    reconcileRetainedCodexHookHomes({
      hookService: { install, refreshRuntimeUserHooks },
      hooksEnabled: true,
      runtimeHomePaths: ['/orca/shared-home', '/orca/account-home']
    })

    expect(install).toHaveBeenCalledTimes(2)
    expect(install).toHaveBeenNthCalledWith(1, '/orca/shared-home')
    expect(install).toHaveBeenNthCalledWith(2, '/orca/account-home')
    expect(refreshRuntimeUserHooks).not.toHaveBeenCalled()
  })

  it('removes only Orca hooks from retained homes when hooks are disabled', () => {
    const install = vi.fn(() => status('installed'))
    const refreshRuntimeUserHooks = vi.fn(() => status('not_installed'))

    reconcileRetainedCodexHookHomes({
      hookService: { install, refreshRuntimeUserHooks },
      hooksEnabled: false,
      runtimeHomePaths: ['/orca/shared-home']
    })

    expect(refreshRuntimeUserHooks).toHaveBeenCalledWith('/orca/shared-home')
    expect(install).not.toHaveBeenCalled()
  })
})
