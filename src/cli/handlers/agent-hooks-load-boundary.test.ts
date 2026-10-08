import { afterEach, expect, it, vi } from 'vitest'
import { main } from '../index'

const { call } = vi.hoisted(() => ({ call: vi.fn(async () => ({ result: null })) }))
vi.mock('../runtime-client', () => ({
  RuntimeClient: class {
    call = call
  },
  RuntimeClientError: Error,
  getDefaultUserDataPath: () => '/unused/user-data'
}))
vi.mock('../../main/persistence/profile-state/profile-state-offline-settings', () => {
  throw new Error('Offline profile settings loaded during online preparation')
})
vi.mock('../../main/persistence/profile-state/profile-state-access', () => {
  throw new Error('Profile admission loaded during online preparation')
})
vi.mock('../profile-state-location', () => {
  throw new Error('Profile location loaded during online preparation')
})
vi.mock('../../main/codex/codex-hook-local-install', () => {
  throw new Error('The Codex installer loaded in the pane CLI')
})

afterEach(() => {
  call.mockClear()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = undefined
})

it('prepares a WSL pane through the runtime without loading profile storage or an installer', async () => {
  vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await main(['agent', 'hooks', 'prepare-codex'])
  expect(error).not.toHaveBeenCalled()
  expect(call).toHaveBeenCalledWith('agentHooks.prepareCodexForWslPane', expect.any(Object), {
    timeoutMs: 50_000
  })
})

it('loads nothing and asks nothing for a native pane', async () => {
  vi.stubEnv('WSL_DISTRO_NAME', '')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await main(['agent', 'hooks', 'prepare-codex'])
  expect(error).not.toHaveBeenCalled()
  expect(call).not.toHaveBeenCalled()
})
