import { describe, expect, it, vi } from 'vitest'
import { executeMobileWebNavigationOperation } from './mobile-web-navigation-operations'

describe('mobile web navigation operations', () => {
  it('routes only to named native-shell destinations', async () => {
    const authority = navigationAuthority()

    await expect(
      executeMobileWebNavigationOperation({
        operation: 'route',
        payload: { destination: 'pairingRepair' },
        authority
      })
    ).resolves.toBeNull()

    expect(authority.route).toHaveBeenCalledWith('pairingRepair')
    await expect(
      executeMobileWebNavigationOperation({
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
        operation: 'reconnect',
        payload: {},
        authority
      })
    ).resolves.toBeNull()
    expect(authority.reconnect).toHaveBeenCalledWith()
  })

  it('rejects a destination the shell no longer owns', async () => {
    const authority = navigationAuthority()

    await expect(
      executeMobileWebNavigationOperation({
        operation: 'route',
        payload: { destination: 'connectionLog' },
        authority
      })
    ).rejects.toBeTruthy()
    expect(authority.route).not.toHaveBeenCalled()
  })

  it('removes the native-selected host without accepting page identity', async () => {
    const authority = navigationAuthority()

    await expect(
      executeMobileWebNavigationOperation({
        operation: 'removeHost',
        payload: { confirmation: 'remove-paired-host' },
        authority
      })
    ).resolves.toBeNull()

    expect(authority.removeHost).toHaveBeenCalledWith()
    await expect(
      executeMobileWebNavigationOperation({
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
