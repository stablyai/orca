import { describe, expect, it, vi } from 'vitest'
import type { DesktopRelayService } from '../desktop-relay-service'
import { createDesktopRelayServiceInstaller } from '../desktop-relay-service-installer'

function fakeService(): DesktopRelayService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the installer only calls start() and wraps the provider methods.
  return { start: vi.fn() } as unknown as DesktopRelayService
}

function installerWith(overrides: {
  create: () => DesktopRelayService | null
  isFenced?: () => boolean
  whenNetworkReady?: Promise<unknown>
}) {
  const runtimeRpc = { setMobileRelayPairingProvider: vi.fn() }
  const onInstalled = vi.fn()
  const installer = createDesktopRelayServiceInstaller({
    runtimeRpc,
    whenNetworkReady: overrides.whenNetworkReady ?? Promise.resolve(),
    isFenced: overrides.isFenced ?? (() => false),
    create: overrides.create,
    onInstalled
  })
  return { installer, runtimeRpc, onInstalled }
}

describe('createDesktopRelayServiceInstaller', () => {
  it('refuses installs after sign-out, including one already waiting, until the next auth change', async () => {
    let ready!: () => void
    const whenNetworkReady = new Promise<void>((resolve) => (ready = resolve))
    const create = vi.fn(() => fakeService())
    const { installer } = installerWith({ create, whenNetworkReady })

    const waiting = installer.ensure()
    installer.suspend()
    ready()
    await expect(waiting).resolves.toBe(false)
    await expect(installer.ensure()).resolves.toBe(false)
    expect(create).not.toHaveBeenCalled()
    await expect(installer.authChanged()).resolves.toBe(true)
    expect(create).toHaveBeenCalledOnce()
  })
})
