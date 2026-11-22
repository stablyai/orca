import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeRpcServer } from '../rpc/server/runtime-rpc'
import { installRelayHost } from './relay-host-install'

const { services } = vi.hoisted(() => {
  const services: { calls: string[] }[] = []
  return { services }
})
vi.mock('../../orca-profiles/cloud-auth/profile-cloud-auth-config', () => ({
  getOrcaCloudAuthConfig: () => ({ configured: true, config: {} })
}))
vi.mock('./desktop-relay-service', () => ({
  DesktopRelayService: class {
    calls: string[] = []
    constructor() {
      services.push(this)
    }
    start() {
      this.calls.push('start')
    }
    authMutated() {
      this.calls.push('authMutated')
    }
    fenceAndCloseNow(reason?: string) {
      this.calls.push(`fence:${reason ?? 'none'}`)
    }
    stop() {
      this.calls.push('stop')
    }
  }
}))

function rpcStub() {
  let installer: (() => Promise<unknown>) | null = null
  const rpc = {
    setMobileRelayPairingProviderInstaller: (next: typeof installer) => {
      installer = next
    },
    setMobileRelayPairingProvider: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay host reads only the two provider setters; the service is mocked above.
  return { rpc: rpc as unknown as OrcaRuntimeRpcServer, installer: () => installer, raw: rpc }
}

function hostWith(rpc: OrcaRuntimeRpcServer) {
  return installRelayHost({
    runtimeRpc: rpc,
    userDataPath: '/unused',
    appVersion: '0.0.0',
    whenNetworkReady: Promise.resolve(),
    isFenced: () => false,
    onStatus: () => {}
  })
}

describe('installRelayHost', () => {
  it('starts at once, tells paired phones on sign-out, and serves the next sign-in', async () => {
    services.length = 0
    const { rpc, installer } = rpcStub()
    const host = hostWith(rpc)
    await installer()!()
    expect(services).toHaveLength(1)

    host.signOutStarted()
    host.accountChanged()

    expect(services[0].calls).toEqual(['start', 'fence:signed-out', 'authMutated'])
  })

  it('closes a quit without the sign-out reason and drops the pairing provider on stop', async () => {
    services.length = 0
    const { rpc, installer, raw } = rpcStub()
    const host = hostWith(rpc)
    await installer()!()

    host.fence()
    host.stop()

    expect(services[0].calls).toEqual(['start', 'fence:none', 'stop'])
    expect(installer()).toBeNull()
    expect(raw.setMobileRelayPairingProvider).toHaveBeenLastCalledWith(null)
  })
})
