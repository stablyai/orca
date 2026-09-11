import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({
  state: { isQuitting: false, desktopRelayService: null as unknown },
  configured: true,
  construct: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  authMutated: vi.fn(),
  createPairingRelay: vi.fn()
}))
vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }))
vi.mock('./main-process-state', () => ({ mainProcessState: fakes.state }))
vi.mock('./main-process-relay-status', () => ({ publishDesktopRelayStatus: vi.fn() }))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/unused'
}))
vi.mock('../orca-profiles/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => ({ configured: fakes.configured, config: {} })
}))
vi.mock('../runtime/relay/desktop-relay-service', () => ({
  DesktopRelayService: class {
    constructor() {
      fakes.construct()
    }
    start = fakes.start
    stop = fakes.stop
    authMutated = fakes.authMutated
    createPairingRelay = fakes.createPairingRelay
  }
}))

import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'

describe('desktop relay initialization recovery', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    fakes.state.isQuitting = false
    fakes.state.desktopRelayService = null
    fakes.configured = true
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  function runtime() {
    return { setMobileRelayPairingProvider: vi.fn() } as unknown as OrcaRuntimeRpcServer
  }

  it('waits for desktop startup, recovers a failed construction, and installs one provider', async () => {
    const { ensureDesktopRelayService, startDesktopRelayService } =
      await import('./main-process-relay-startup')
    const rpc = runtime()
    expect(ensureDesktopRelayService()).toBeNull()
    expect(fakes.construct).not.toHaveBeenCalled()
    fakes.construct.mockImplementationOnce(() => {
      throw new Error('mobile_runtime_not_ready')
    })
    startDesktopRelayService(rpc)
    expect(fakes.state.desktopRelayService).toBeNull()
    expect(rpc.setMobileRelayPairingProvider).toHaveBeenLastCalledWith(null)

    ensureDesktopRelayService()?.authMutated()
    const service = fakes.state.desktopRelayService
    expect(service).not.toBeNull()
    expect(fakes.authMutated).toHaveBeenCalledOnce()
    expect(ensureDesktopRelayService()).toBe(service)
    expect(fakes.construct).toHaveBeenCalledTimes(2)
    expect(fakes.start).toHaveBeenCalledOnce()
    const provider = vi.mocked(rpc.setMobileRelayPairingProvider).mock.calls.at(-1)![0]!
    fakes.createPairingRelay.mockResolvedValue({ relay: 'test-offer' })
    await expect(provider.createPairingRelay('phone')).resolves.toEqual({ relay: 'test-offer' })
    expect(fakes.createPairingRelay).toHaveBeenCalledWith('phone')
  })

  it('removes a partially started provider before allowing another attempt', async () => {
    const { ensureDesktopRelayService, startDesktopRelayService } =
      await import('./main-process-relay-startup')
    const rpc = runtime()
    fakes.start.mockImplementationOnce(() => {
      throw new Error('start failed')
    })
    startDesktopRelayService(rpc)
    expect(fakes.stop).toHaveBeenCalledOnce()
    expect(rpc.setMobileRelayPairingProvider).toHaveBeenLastCalledWith(null)
    expect(fakes.state.desktopRelayService).toBeNull()
    expect(ensureDesktopRelayService()).not.toBeNull()
  })

  it('skips unconfigured builds and never resurrects a quitting desktop', async () => {
    const { ensureDesktopRelayService, startDesktopRelayService } =
      await import('./main-process-relay-startup')
    fakes.configured = false
    startDesktopRelayService(runtime())
    ensureDesktopRelayService()
    expect(fakes.construct).not.toHaveBeenCalled()
    fakes.configured = true
    fakes.state.isQuitting = true
    expect(ensureDesktopRelayService()).toBeNull()
    expect(fakes.construct).not.toHaveBeenCalled()
  })
})
