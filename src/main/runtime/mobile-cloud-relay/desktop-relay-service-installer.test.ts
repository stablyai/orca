import { describe, expect, it, vi } from 'vitest'
import type { DesktopRelayService } from './desktop-relay-service'
import { createDesktopRelayServiceInstaller } from './desktop-relay-service-installer'

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
  it('retries a construction that failed at launch on the next demand, without a restart', async () => {
    const service = fakeService()
    const create = vi
      .fn<() => DesktopRelayService | null>()
      .mockImplementationOnce(() => {
        throw new Error('mobile_runtime_not_ready')
      })
      .mockReturnValueOnce(service)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { installer, runtimeRpc, onInstalled } = installerWith({ create })

    await expect(installer.ensure()).resolves.toBe(false)
    expect(runtimeRpc.setMobileRelayPairingProvider).not.toHaveBeenCalled()
    await expect(installer.ensure()).resolves.toBe(true)
    expect(onInstalled).toHaveBeenCalledWith(service)
    expect(runtimeRpc.setMobileRelayPairingProvider).toHaveBeenCalledOnce()
    expect(service.start).toHaveBeenCalledOnce()
    await expect(installer.ensure()).resolves.toBe(true)
    expect(create).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('holds the first install until the network is ready and shares one in-flight install', async () => {
    let ready!: () => void
    const whenNetworkReady = new Promise<void>((resolve) => (ready = resolve))
    const create = vi.fn(() => fakeService())
    const { installer } = installerWith({ create, whenNetworkReady })

    const first = installer.ensure()
    const second = installer.ensure()
    await Promise.resolve()
    expect(create).not.toHaveBeenCalled()
    ready()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(create).toHaveBeenCalledOnce()
  })

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

  it('never installs once quit or relaunch fenced the host', async () => {
    const create = vi.fn(() => fakeService())
    const { installer } = installerWith({ create, isFenced: () => true })

    await expect(installer.ensure()).resolves.toBe(false)
    expect(create).not.toHaveBeenCalled()
  })
})
