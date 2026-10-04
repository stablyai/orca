import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepareRuntimeHomeForLaunch: vi.fn(
    async (): Promise<{ state: string; configPath?: string; detail?: string }> => ({ state: 'ok' })
  )
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/orca-user-data') } }))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: mocks.prepareRuntimeHomeForLaunch }
}))
vi.mock('../codex/codex-real-home-hook-install', () => ({
  ensureRealHomeCodexHookState: vi.fn(async () => {})
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabledForAgent: () => true
}))
vi.mock('../wsl', () => ({ getDefaultWslDistro: () => 'Ubuntu' }))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    codexRuntimeHome: {
      prepareForCodexLaunchAsync: vi.fn(async () => '/managed/.codex'),
      isHostSystemDefaultRealHomeSelected: () => false
    },
    store: { getSettings: () => ({}) }
  }
}))

import { prepareCodexRuntimeHomeForLaunch } from './codex-launch-preparation'

describe('Codex launch-prep hook status warning', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('logs a repeated hook status error once and a new one again', async () => {
    const detail =
      'Hooks installed but trust entries could not be written: Orca left /tmp/launch-hook-trust-probe/config.toml unchanged (line 2): the file is not valid TOML.'
    const refused = {
      state: 'error',
      configPath: '/tmp/launch-hook-trust-probe/hooks.json',
      detail
    }
    mocks.prepareRuntimeHomeForLaunch.mockResolvedValue(refused)
    for (let launch = 0; launch < 3; launch++) {
      await prepareCodexRuntimeHomeForLaunch()
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('[codex-hook-service]')
    expect(String(warn.mock.calls[0]?.[0])).toContain('(line 2)')

    mocks.prepareRuntimeHomeForLaunch.mockResolvedValue({
      ...refused,
      detail: detail.replace('line 2', 'line 5')
    })
    await prepareCodexRuntimeHomeForLaunch()
    expect(warn).toHaveBeenCalledTimes(2)
  })
})
