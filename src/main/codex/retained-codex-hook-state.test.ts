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
  it('repairs MCode hooks before a retained shell can launch Codex', () => {
    const install = vi.fn(() => status('installed'))
    const refreshRuntimeUserHooks = vi.fn(() => status('not_installed'))

    reconcileRetainedCodexHookHomes({
      hookService: { install, refreshRuntimeUserHooks },
      hooksEnabled: true,
      runtimeHomePaths: ['/mcode/shared-home', '/mcode/account-home']
    })

    expect(install).toHaveBeenCalledTimes(2)
    expect(install).toHaveBeenNthCalledWith(1, '/mcode/shared-home')
    expect(install).toHaveBeenNthCalledWith(2, '/mcode/account-home')
    expect(refreshRuntimeUserHooks).not.toHaveBeenCalled()
  })

  it('removes only MCode hooks from retained homes when hooks are disabled', () => {
    const install = vi.fn(() => status('installed'))
    const refreshRuntimeUserHooks = vi.fn(() => status('not_installed'))

    reconcileRetainedCodexHookHomes({
      hookService: { install, refreshRuntimeUserHooks },
      hooksEnabled: false,
      runtimeHomePaths: ['/mcode/shared-home']
    })

    expect(refreshRuntimeUserHooks).toHaveBeenCalledWith('/mcode/shared-home')
    expect(install).not.toHaveBeenCalled()
  })
})
