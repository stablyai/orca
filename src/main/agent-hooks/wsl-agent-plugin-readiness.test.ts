import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  blocked: vi.fn(async (): Promise<{ distro: string; state: string } | null> => null)
}))
vi.mock('../wsl/wsl-background-exec-gate', () => ({ blockedWslDistroForExec: mocks.blocked }))

import { awaitExplicitAgentPluginGuestReadiness } from './wsl-agent-plugin-readiness'

function manager() {
  return {
    ensureForDistro: vi.fn(async () => {}),
    getGuestEndpointFilePath: vi.fn(() => '/tmp/endpoint'),
    getGuestAgentPath: vi.fn(() => '/tmp/pi')
  }
}

beforeEach(() => {
  mocks.blocked.mockReset().mockResolvedValue(null)
})

// Ensuring the hook relay launches wsl.exe, before a passive restore's hold (#35813, E9).
describe('explicit agent plugin readiness on WSL', () => {
  it('does not ensure the relay of a stopped distro', async () => {
    mocks.blocked.mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
    const relay = manager()
    await expect(
      awaitExplicitAgentPluginGuestReadiness({
        isWsl: true,
        distro: 'Ubuntu',
        launchAgent: 'pi',
        manager: relay
      })
    ).resolves.toBe(false)
    expect(mocks.blocked).toHaveBeenCalledWith('Ubuntu')
    expect(relay.ensureForDistro).not.toHaveBeenCalled()
  })

  it('ensures it for a running distro, or inside a user act', async () => {
    const relay = manager()
    await expect(
      awaitExplicitAgentPluginGuestReadiness({
        isWsl: true,
        distro: 'Ubuntu',
        launchAgent: 'pi',
        manager: relay
      })
    ).resolves.toBe(true)
    expect(relay.ensureForDistro).toHaveBeenCalledWith('Ubuntu', undefined, 'pi')
  })
})
