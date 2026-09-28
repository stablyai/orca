import { beforeEach, expect, it, vi } from 'vitest'
import { prepareCodexSessionResumeForLaunch } from './codex-session-resume-launch'
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  settings: {
    codexManagedAccounts: [],
    activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'selected' } }
  }
}))
vi.mock('electron', () => ({ app: { getPath: () => '/data' } }))
vi.mock('../codex/codex-wsl-session-resume', () => ({
  prepareCapturedWslCodexSessionResume: mocks.prepare
}))
vi.mock('./main-process-state', () => ({
  mainProcessState: { codexRuntimeHome: null, store: { getSettings: () => mocks.settings } }
}))
vi.mock('../codex/hook-service', () => ({ codexHookService: {} }))
vi.mock('../codex/codex-real-home-hook-install', () => ({ ensureRealHomeCodexHookState: vi.fn() }))
vi.mock('../codex/codex-legacy-session-resume', () => ({
  prepareLegacySharedCodexSessionResume: vi.fn()
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabled: vi.fn()
}))
vi.mock('../agent-trust-presets', () => ({ markCodexProjectTrusted: vi.fn() }))
vi.mock('../codex/codex-home-paths', () => ({
  getSystemCodexHomePath: vi.fn(),
  getOrcaManagedCodexHomePath: vi.fn()
}))
const execution = { distro: 'Ubuntu', userName: 'alice', userId: '1000', home: '/home/alice' }
const providerSession = { key: 'session_id', id: '11111111-2222-3333-4444-555555555555' } as const
beforeEach(() => {
  mocks.prepare.mockReset()
})
it('preserves the existing WSL route when no captured execution identity is supplied', async () => {
  expect(
    await prepareCodexSessionResumeForLaunch({
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      providerSession
    })
  ).toBeNull()
  expect(mocks.prepare).not.toHaveBeenCalled()
})
it('routes captured WSL resume through guest verification even without a host runtime home', async () => {
  mocks.prepare.mockResolvedValue({
    outcome: 'resume',
    codexHomePath: '/home/alice/account-origin'
  })
  expect(
    await prepareCodexSessionResumeForLaunch({
      wslExecution: execution,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      providerSession
    })
  ).toEqual({ outcome: 'resume', codexHomePath: '/home/alice/account-origin' })
  expect(mocks.prepare).toHaveBeenCalledWith({
    execution,
    target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
    providerSession,
    accounts: [],
    selectedAccountId: 'selected'
  })
})
it('propagates unverifiable guest ownership instead of silently using the selected account', async () => {
  mocks.prepare.mockRejectedValue(new Error('owner changed'))
  await expect(
    prepareCodexSessionResumeForLaunch({
      wslExecution: execution,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      providerSession
    })
  ).rejects.toThrow('owner changed')
})
