import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  realHomeSelected: vi.fn(),
  hooks: vi.fn(),
  realHooks: vi.fn(),
  settings: { agentStatusHooksEnabled: true },
  trust: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => '/profile' } }))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    codexRuntimeHome: {
      prepareForCodexLaunchAsync: mocks.prepare,
      isHostSystemDefaultRealHomeSelected: mocks.realHomeSelected
    },
    store: { getSettings: () => mocks.settings }
  }
}))
vi.mock('../agent-trust-presets', () => ({ markCodexProjectTrusted: mocks.trust }))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: mocks.hooks }
}))
vi.mock('../codex/codex-real-home-hook-install', () => ({
  ensureRealHomeCodexHookState: mocks.realHooks
}))
vi.mock('../wsl', () => ({ getDefaultWslDistro: () => 'wrong-default' }))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabled: (settings: { agentStatusHooksEnabled: boolean }) =>
    settings.agentStatusHooksEnabled
}))

import { prepareCodexRuntimeHomeForLaunch } from './codex-launch-preparation'

const owner = { distro: 'Ubuntu', userName: 'alice', userId: '1000', home: '/home/alice' }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.prepare.mockResolvedValue('/home/alice/.codex')
  mocks.realHomeSelected.mockReturnValue(false)
  mocks.hooks.mockResolvedValue({ state: 'installed' })
  mocks.settings.agentStatusHooksEnabled = true
})

describe('Codex startup launch wrapper', () => {
  it.each([true, false])(
    'leaves captured guest hooks to guest preparation, hooks enabled=%s',
    async (enabled) => {
      mocks.settings.agentStatusHooksEnabled = enabled
      const execution = { ...owner }
      mocks.prepare.mockImplementation(async () => {
        execution.userName = 'bob'
        execution.home = '/home/bob'
        return '/home/alice/.codex'
      })
      expect(
        await prepareCodexRuntimeHomeForLaunch(
          { runtime: 'wsl', wslDistro: 'Ubuntu' },
          {},
          { wslExecution: execution }
        )
      ).toBe('/home/alice/.codex')
      expect(mocks.prepare).toHaveBeenCalledWith(
        { runtime: 'wsl', wslDistro: 'Ubuntu' },
        {},
        { unavailableManagedHomePath: undefined, wslExecution: owner }
      )
      expect(Object.isFrozen(mocks.prepare.mock.calls[0]?.[2].wslExecution)).toBe(true)
      expect(mocks.hooks).not.toHaveBeenCalled()
      expect(mocks.realHooks).not.toHaveBeenCalled()
      expect(mocks.trust).not.toHaveBeenCalled()
    }
  )

  it('refuses a captured owner paired with a host or different distro before preparation', async () => {
    await expect(
      prepareCodexRuntimeHomeForLaunch({ runtime: 'host' }, {}, { wslExecution: owner })
    ).rejects.toThrow('captured execution owner')
    await expect(
      prepareCodexRuntimeHomeForLaunch(
        { runtime: 'wsl', wslDistro: 'Debian' },
        {},
        { wslExecution: owner }
      )
    ).rejects.toThrow('captured execution owner')
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.hooks).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'keeps legacy noncaptured hook preparation, hooks enabled=%s',
    async (enabled) => {
      mocks.settings.agentStatusHooksEnabled = enabled
      await prepareCodexRuntimeHomeForLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      expect(mocks.hooks).toHaveBeenCalledWith(
        '/home/alice/.codex',
        { runtime: 'wsl', wslDistro: 'Ubuntu' },
        enabled
      )
    }
  )

  it('preserves host managed-home fallback and second preparation', async () => {
    mocks.prepare.mockResolvedValueOnce(null).mockResolvedValueOnce('/managed')
    mocks.realHomeSelected.mockReturnValueOnce(false).mockReturnValueOnce(true)
    expect(
      await prepareCodexRuntimeHomeForLaunch(
        { runtime: 'host' },
        {},
        { unavailableManagedHomePath: '/old' }
      )
    ).toBe('/managed')
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(mocks.prepare).toHaveBeenLastCalledWith(
      { runtime: 'host' },
      {},
      { unavailableManagedHomePath: '/old' }
    )
    expect(mocks.realHooks).toHaveBeenCalledTimes(1)
  })
})
