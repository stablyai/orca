import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import { _resetSecretStoreForTests, setSecretStore } from '../../../shared/secret-store'
import { parsePairingCode } from '../../../shared/pairing'
import type { PairingGetEndpointsResult } from '../../../shared/mobile-relay-credential-contract'
import type { MobilePairingConnectionContext } from '../runtime-rpc'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { DeviceRegistry } from '../device-registry'
import { DesktopRelayProviders } from './desktop-relay-providers'
import type { DesktopRelayService } from './desktop-relay-service'

const settings = { url: 'https://relay.example.com', accessKey: 'k'.repeat(64) }
type ServiceOptions = ConstructorParameters<typeof DesktopRelayService>[0]
function fakeService(options: ServiceOptions) {
  const origin = options.selfHosted?.relayDirectorUrl ?? 'https://official.example.com'
  return {
    options,
    start: vi.fn(() => options.onStatus('standby')),
    stop: vi.fn(),
    ensureLive: vi.fn(),
    fenceAndCloseNow: vi.fn(),
    demandStateChanged: vi.fn(),
    createPairingRelay: vi.fn(async (relayDeviceId: string) => ({
      relay: {
        v: 1 as const,
        directorUrl: origin,
        cellUrl: origin,
        assignmentEpoch: 1,
        relayHostId: 'AbCdEf0123_-xyZ9',
        inviteToken: 'A'.repeat(43),
        inviteExpiresAt: Date.now() + 60_000,
        e2eeFraming: 2 as const
      },
      binding: {
        relayHostId: 'AbCdEf0123_-xyZ9',
        relayDeviceId,
        ownerIdentityKey: options.selfHosted ? `self-hosted\0${origin}\0` : 'user\0profile\0org'
      }
    })),
    onDeviceRevokeQueued: vi.fn(),
    getEndpoints: vi.fn(async (): Promise<PairingGetEndpointsResult> => ({ v: 1, relay: null })),
    provisionRelay: vi.fn()
  }
}
function direct(deviceId: string): MobilePairingConnectionContext {
  return { deviceId, connectionId: 'direct-connection', transport: { transport: 'direct' } }
}
let directory: string
let server: OrcaRuntimeRpcServer
let manager: DesktopRelayProviders
let services: ReturnType<typeof fakeService>[]
const createService = vi.fn((options: ServiceOptions) => {
  const service = fakeService(options)
  services.push(service)
  return service
})

beforeEach(async () => {
  services = []
  createService.mockClear()
  setSecretStore({
    isEncryptionAvailable: () => true,
    describeProtectionGap: () => null,
    encryptString: () => Buffer.from('sealed-fixture'),
    decryptString: () => settings.accessKey
  })
  directory = mkdtempSync(join(tmpdir(), 'orca-relay-providers-'))
  server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: directory,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  const auth = getOrcaCloudAuthConfig({}, true)
  if (!auth.configured) {
    throw new Error('Official config unavailable')
  }
  manager = new DesktopRelayProviders({
    authConfig: auth.config,
    userDataPath: directory,
    settingsPath: directory,
    packaged: true,
    appVersion: '1.0.0',
    runtimeRpc: server,
    onStatus: vi.fn(),
    createService
  })
  server.setMobileRelayPairingProvider(manager)
})

afterEach(async () => {
  manager.stop()
  await server.stop()
  _resetSecretStoreForTests()
  rmSync(directory, { recursive: true, force: true })
})

async function pair(relayProvider: 'official' | 'self-hosted') {
  const offer = await server.createMobilePairingOffer({ relayProvider })
  if (!offer.available) {
    throw new Error(offer.guidance)
  }
  return offer
}

describe('DesktopRelayProviders', () => {
  it('keeps existing official devices and new self-hosted devices on their respective Relays', async () => {
    manager.start()
    const official = await pair('official')
    server.getDeviceRegistry()!.updateLastSeen(official.deviceId)
    manager.saveSelfHosted(settings)
    const selfHosted = await pair('self-hosted')
    server.getDeviceRegistry()!.updateLastSeen(selfHosted.deviceId)
    const registry = new DeviceRegistry(directory)
    expect(registry.getMobileRelayProvider(official.deviceId)).toBe('official')
    expect(registry.getMobileRelayProvider(selfHosted.deviceId)).toBe('self-hosted')
    expect(parsePairingCode(selfHosted.pairingUrl)?.relay?.directorUrl).toBe(settings.url)
    expect(selfHosted.pairingUrl).not.toContain(settings.accessKey)
    expect(JSON.stringify(manager.getStatus())).not.toContain(settings.accessKey)
    await manager.getEndpoints(direct(official.deviceId), {})
    await manager.getEndpoints(direct(selfHosted.deviceId), {})
    expect(services[0]!.getEndpoints).toHaveBeenCalledWith(direct(official.deviceId), {})
    expect(services[1]!.getEndpoints).toHaveBeenCalledWith(direct(selfHosted.deviceId), {})
    manager.fenceAndCloseNow('signed-out')
    expect(services[0]!.fenceAndCloseNow).toHaveBeenCalledWith('signed-out')
    expect(services[1]!.fenceAndCloseNow).not.toHaveBeenCalled()
    await pair('self-hosted')
    manager.removeSelfHosted()
    expect(services[1]!.stop).toHaveBeenCalledOnce()
    expect(services[0]!.stop).not.toHaveBeenCalled()
    await manager.getEndpoints(direct(official.deviceId), {})
    expect(services[0]!.getEndpoints).toHaveBeenCalledTimes(2)
  })

  it('keeps official Relay available when the self-hosted file cannot be loaded', async () => {
    writeFileSync(join(directory, 'mobile-self-hosted-relay.json'), 'corrupt')
    manager.start()
    expect(manager.getStatus()).toMatchObject({
      status: 'standby',
      selfHosted: { configured: false }
    })
    await pair('official')
    expect(services[0]!.createPairingRelay).toHaveBeenCalledOnce()
    expect(readFileSync(join(directory, 'mobile-self-hosted-relay.json'), 'utf8')).toBe('corrupt')
  })

  it('revokes the old pending code when the provider changes', async () => {
    manager.start()
    manager.saveSelfHosted(settings)
    const first = await pair('official')
    const second = await pair('self-hosted')
    expect(second.deviceId).not.toBe(first.deviceId)
    expect(server.getDeviceRegistry()!.getDevice(first.deviceId)).toBeNull()
    expect(services[0]!.onDeviceRevokeQueued).toHaveBeenCalledWith(
      expect.objectContaining({ relayDeviceId: first.deviceId })
    )
  })

  it('requires re-pairing to move an existing self-hosted device to a replacement origin', async () => {
    manager.start()
    manager.saveSelfHosted(settings)
    const first = await pair('self-hosted')
    server.getDeviceRegistry()!.updateLastSeen(first.deviceId)
    const oldStatus = manager.getStatus()
    manager.saveSelfHosted({ ...settings, url: 'https://replacement.example.com' })
    services[1]!.options.onStatus('registered', settings.url)
    expect(oldStatus.selfHosted?.url).toBe(settings.url)
    expect(manager.getStatus().selfHosted?.url).toBe('https://replacement.example.com')
    expect(await manager.getEndpoints(direct(first.deviceId), {})).toEqual({ v: 1, relay: null })
    expect(services[2]!.getEndpoints).not.toHaveBeenCalled()
    const next = await pair('self-hosted')
    expect(parsePairingCode(next.pairingUrl)?.relay?.directorUrl).toBe(
      'https://replacement.example.com'
    )
  })

  it('does not replace a working saved configuration when construction fails', () => {
    manager.start()
    manager.saveSelfHosted(settings)
    const before = readFileSync(join(directory, 'mobile-self-hosted-relay.json'), 'utf8')
    createService.mockImplementationOnce(() => {
      throw new Error('mobile_runtime_not_ready')
    })
    expect(() =>
      manager.saveSelfHosted({ ...settings, url: 'https://replacement.example.com' })
    ).toThrow('mobile_runtime_not_ready')
    expect(readFileSync(join(directory, 'mobile-self-hosted-relay.json'), 'utf8')).toBe(before)
    expect(services[1]!.stop).not.toHaveBeenCalled()
    expect(manager.getStatus().selfHosted?.url).toBe(settings.url)
  })

  it('discards a delayed invite from a removed configuration', async () => {
    manager.start()
    manager.saveSelfHosted(settings)
    const service = services[1]!
    const normalMint = service.createPairingRelay.getMockImplementation()!
    let release = () => {}
    service.createPairingRelay.mockImplementationOnce(async (deviceId) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return normalMint(deviceId)
    })
    const request = server.createMobilePairingOffer({ relayProvider: 'self-hosted' })
    await vi.waitFor(() => expect(service.createPairingRelay).toHaveBeenCalledOnce())
    manager.removeSelfHosted()
    release()
    expect(await request).toMatchObject({
      available: false,
      relayFailure: { code: 'relay_request_superseded' }
    })
    expect(server.getDeviceRegistry()!.getPendingDevice('mobile')).toBeNull()
    expect(
      server.getRelayRevokeOutbox().pendingFor(`self-hosted\0${settings.url}\0`, 'AbCdEf0123_-xyZ9')
    ).toHaveLength(1)
  })

  it('does not cancel an official invite while saving self-hosted settings', async () => {
    manager.start()
    const official = services[0]!
    const normalMint = official.createPairingRelay.getMockImplementation()!
    let release = () => {}
    official.createPairingRelay.mockImplementationOnce(async (deviceId) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return normalMint(deviceId)
    })
    const request = server.createMobilePairingOffer({})
    await vi.waitFor(() => expect(official.createPairingRelay).toHaveBeenCalledOnce())
    manager.saveSelfHosted(settings)
    release()
    expect(await request).toMatchObject({ available: true })
  })
})
