import { expect, it } from 'vitest'
import type { DesktopRelayService } from './desktop-relay-service'
import { createDesktopRelayServiceInstaller } from './desktop-relay-service-installer'

it('a stopped relay installer never installs again', async () => {
  let networkReady!: () => void
  const whenNetworkReady = new Promise<void>((resolve) => {
    networkReady = resolve
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: installation only calls start; no pairing operations are exercised.
  const service = { start: () => {} } as DesktopRelayService
  const installer = createDesktopRelayServiceInstaller({
    runtimeRpc: { setMobileRelayPairingProvider: () => {} },
    whenNetworkReady,
    isFenced: () => false,
    create: () => service,
    onInstalled: () => {}
  })

  const pending = installer.ensure()
  installer.stop()
  networkReady()

  await expect(pending).resolves.toBe(false)
  await expect(installer.authChanged()).resolves.toBe(false)
  await expect(installer.ensure()).resolves.toBe(false)
})
