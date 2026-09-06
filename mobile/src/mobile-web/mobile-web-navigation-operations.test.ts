import { describe, expect, it, vi } from 'vitest'
import { executeMobileWebNavigationOperation } from './mobile-web-navigation-operations'

describe('mobile web navigation operations', () => {
  it('routes only to named native-shell destinations', async () => {
    const authority = navigationAuthority()

    await expect(
      executeMobileWebNavigationOperation({
        requestId: 'A'.repeat(22),
        operation: 'route',
        payload: { destination: 'pairingRepair' },
        authority
      })
    ).resolves.toBeNull()

    expect(authority.route).toHaveBeenCalledWith('pairingRepair', 'A'.repeat(22))
    await expect(
      executeMobileWebNavigationOperation({
        requestId: 'B'.repeat(22),
        operation: 'route',
        payload: { destination: 'https://attacker.invalid' },
        authority
      })
    ).rejects.toBeTruthy()
  })

  it('reconnects and removes the host through the native authority', async () => {
    const authority = navigationAuthority()

    await expect(
      executeMobileWebNavigationOperation({
        requestId: 'C'.repeat(22),
        operation: 'reconnect',
        payload: {},
        authority
      })
    ).resolves.toBeNull()
    expect(authority.reconnect).toHaveBeenCalledWith()
  })

  it('routes to native settings through the shell authority', async () => {
    const authority = navigationAuthority()

    await expect(
      executeMobileWebNavigationOperation({
        requestId: 'F'.repeat(22),
        operation: 'route',
        payload: { destination: 'terminalSettings' },
        authority
      })
    ).resolves.toBeNull()
    expect(authority.route).toHaveBeenCalledWith('terminalSettings', 'F'.repeat(22))
  })

  it('removes the native-selected host without accepting page identity', async () => {
    const authority = navigationAuthority()

    await expect(
      executeMobileWebNavigationOperation({
        requestId: 'G'.repeat(22),
        operation: 'removeHost',
        payload: { confirmation: 'remove-paired-host' },
        authority
      })
    ).resolves.toBeNull()

    expect(authority.removeHost).toHaveBeenCalledWith()
    await expect(
      executeMobileWebNavigationOperation({
        requestId: 'H'.repeat(22),
        operation: 'removeHost',
        payload: { confirmation: 'remove-paired-host', hostId: 'attacker-host' },
        authority
      })
    ).rejects.toBeTruthy()
  })
})

function navigationAuthority() {
  return {
    route: vi.fn(),
    reconnect: vi.fn(),
    removeHost: vi.fn()
  }
}
