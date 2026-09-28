import { afterEach, expect, it, vi } from 'vitest'
import { main } from '../index'

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }))
vi.mock('../runtime-client', () => ({
  RuntimeClient: class {
    async call() {
      return { result: { settings: { agentStatusHooksEnabled: true } } }
    }
  },
  RuntimeClientError: Error,
  getDefaultUserDataPath: () => '/unused/user-data'
}))
vi.mock('../../main/codex/managed-home-shell-preflight', () => ({
  prepareManagedCodexHomeBeforeShellLaunch: prepare
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

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = undefined
})

it('prepares Codex through the runtime without loading offline profile storage', async () => {
  vi.stubEnv('WSL_DISTRO_NAME', '')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await main(['agent', 'hooks', 'prepare-codex'])
  expect(error).not.toHaveBeenCalled()
  expect(prepare).toHaveBeenCalledWith({
    userDataPath: '/unused/user-data',
    hooksEnabled: true
  })
})
