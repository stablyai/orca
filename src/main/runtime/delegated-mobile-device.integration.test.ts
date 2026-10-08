import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from '../../shared/pairing'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import {
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  type DelegatedMobileDeviceSyncResult
} from '../../shared/delegated-mobile-device-contract'
import { sendRequest } from './runtime-rpc-test-harness'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest,
  waitForWsClose
} from './runtime-rpc-mobile-ws-test-harness'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

type DelegatedDevice = DelegatedMobileDeviceSyncResult['devices'][number]

describe('pairing.delegatedMobileDevice.sync', () => {
  const cleanups: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup()
    }
  })

  async function startServer(userDataPath = mkdtempSync(join(tmpdir(), 'orca-delegated-'))) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store carries the surface these RPCs read, as in the sibling WebSocket tests.
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    cleanups.push(() => server.stop())
    return { server, userDataPath, registry: server.getDeviceRegistry()! }
  }

  function pair(
    server: OrcaRuntimeRpcServer,
    args: Parameters<OrcaRuntimeRpcServer['createPairingOffer']>[0]
  ): PairingOffer {
    const offer = server.createPairingOffer({ address: '127.0.0.1', ...args })
    if (!offer.available) {
      throw new Error('pairing unavailable')
    }
    return parsePairingCode(offer.pairingUrl)!
  }

  function pairDesktop(server: OrcaRuntimeRpcServer, name = 'MacBook'): PairingOffer {
    return pair(server, { name, scope: 'runtime' })
  }

  async function sync(
    desktop: PairingOffer,
    phones: { phoneKey: string; name: string }[]
  ): Promise<DelegatedDevice[]> {
    const response = await sendRemoteRuntimeRequest<DelegatedMobileDeviceSyncResult>(
      desktop,
      DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
      { phones },
      5_000
    )
    if (!response.ok) {
      throw new Error(`sync failed: ${response.error.code} ${response.error.message}`)
    }
    return response.result.devices
  }

  function sendSync(desktop: PairingOffer, phones: unknown) {
    return sendRemoteRuntimeRequest(desktop, DELEGATED_MOBILE_DEVICE_SYNC_METHOD, { phones }, 5_000)
  }

  function asPhone(desktop: PairingOffer, device: DelegatedDevice): PairingOffer {
    return {
      ...desktop,
      deviceToken: device.token,
      pairedDeviceId: device.deviceId,
      scope: 'mobile'
    }
  }

  it('advertises the capability a desktop gates on', async () => {
    const { server } = await startServer()
    const status = await sendRemoteRuntimeRequest<{ capabilities: string[] }>(
      pairDesktop(server),
      'status.get',
      {},
      5_000
    )
    expect(status).toMatchObject({ ok: true })
    expect(status.ok && status.result.capabilities).toContain(
      DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY
    )
  })

  it('creates an ordinary mobile device a real E2EE client uses, idempotently', async () => {
    const { server, registry } = await startServer()
    const desktop = pairDesktop(server)
    const devices = await sync(desktop, [{ phoneKey: 'phone-1', name: 'iPhone via MacBook' }])
    expect(devices).toEqual([
      { phoneKey: 'phone-1', deviceId: expect.any(String), token: expect.any(String) }
    ])
    expect(await sync(desktop, [{ phoneKey: 'phone-1', name: 'iPhone via MacBook' }])).toEqual(
      devices
    )
    const child = devices[0]!
    expect(child.deviceId).not.toBe(desktop.pairedDeviceId)
    expect(registry.getDevice(child.deviceId)).toMatchObject({
      name: 'iPhone via MacBook',
      scope: 'mobile',
      parentDeviceId: desktop.pairedDeviceId,
      phoneKey: 'phone-1'
    })

    const phone = asPhone(desktop, child)
    await expect(sendRemoteRuntimeRequest(phone, 'status.get', {}, 5_000)).resolves.toMatchObject({
      ok: true,
      result: { deviceScope: 'mobile' }
    })
    // The mobile allowlist applies, including to sync itself.
    await expect(
      sendRemoteRuntimeRequest(phone, 'worktree.list', {}, 5_000)
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    await expect(
      sendRemoteRuntimeRequest(phone, DELEGATED_MOBILE_DEVICE_SYNC_METHOD, { phones: [] }, 5_000)
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('refuses a directly paired phone and a local caller with no paired device', async () => {
    const { server, registry, userDataPath } = await startServer()
    const phone = pair(server, { name: 'phone', scope: 'mobile' })
    await expect(
      sendRemoteRuntimeRequest(
        phone,
        DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
        { phones: [{ phoneKey: 'p', name: 'p' }] },
        5_000
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'forbidden' } })
    const metadata = readRuntimeMetadata(userDataPath)!
    await expect(
      sendRequest(metadata.transports[0]!.endpoint, {
        id: 'local',
        authToken: metadata.authToken,
        method: DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
        params: { phones: [{ phoneKey: 'p', name: 'p' }] }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_error', message: 'runtime_device_required' }
    })
    expect(registry.listDevices().filter((device) => device.parentDeviceId)).toEqual([])
  })

  it('gives children the parent grant reach, so they never widen the bind', async () => {
    const { server, registry } = await startServer()
    const desktop = pair(server, { name: 'local Mac', scope: 'runtime', reach: 'this-computer' })
    const [child] = await sync(desktop, [{ phoneKey: 'p', name: 'p' }])
    expect(registry.getDevice(child!.deviceId)?.pairingReach).toBe('this-computer')
  })

  it('never lets the QR pending lookups hand out or delete a child', async () => {
    const { server, registry } = await startServer()
    const desktop = pairDesktop(server)
    const [child] = await sync(desktop, [{ phoneKey: 'phone-1', name: 'iPhone via MacBook' }])

    expect(registry.getPendingDevice('mobile')).toBeNull()
    const offer = server.createPairingOffer({ address: '127.0.0.1', scope: 'mobile' })
    expect(offer.available && offer.deviceId).not.toBe(child!.deviceId)
    const rotated = server.createPairingOffer({
      address: '127.0.0.1',
      scope: 'mobile',
      rotate: true
    })
    expect(rotated.available && rotated.deviceId).not.toBe(child!.deviceId)
    expect(registry.getDevice(child!.deviceId)).not.toBeNull()
    await expect(
      sendRemoteRuntimeRequest(asPhone(desktop, child!), 'status.get', {}, 5_000)
    ).resolves.toMatchObject({ ok: true })
  })

  it('revokes a dropped child and closes its socket', async () => {
    const { server, registry } = await startServer()
    const desktop = pairDesktop(server)
    const [a, b] = await sync(desktop, [
      { phoneKey: 'phone-a', name: 'A' },
      { phoneKey: 'phone-b', name: 'B' }
    ])
    const sessionB = await authenticateMobileWsSession(encodePairingOffer(asPhone(desktop, b!)))
    const closedB = waitForWsClose(sessionB.ws)

    expect(await sync(desktop, [{ phoneKey: 'phone-a', name: 'A' }])).toEqual([a])
    expect(registry.getDevice(b!.deviceId)).toBeNull()
    await closedB
  })

  it('cascades a parent revoke to its children only', async () => {
    const { server, registry } = await startServer()
    const desktop = pairDesktop(server)
    const [child] = await sync(desktop, [{ phoneKey: 'phone-a', name: 'A' }])
    // Paired after the first desktop consumed its pending offer; the same phoneKey is scoped per parent.
    const otherDesktop = pairDesktop(server, 'Other Mac')
    const [otherChild] = await sync(otherDesktop, [{ phoneKey: 'phone-a', name: 'A' }])
    expect(otherChild!.deviceId).not.toBe(child!.deviceId)

    const session = await authenticateMobileWsSession(encodePairingOffer(asPhone(desktop, child!)))
    const reader = createEncryptedWsResponseReader(session)
    cleanups.push(() => reader.dispose())
    sendEncryptedWsRequest(session, { id: 's', method: 'status.get' })
    await expect(reader.next('s')).resolves.toMatchObject({ ok: true })
    const closed = waitForWsClose(session.ws)

    expect(server.revokeRuntimeAccess(desktop.pairedDeviceId!)).toBe(true)
    expect(registry.getDevice(child!.deviceId)).toBeNull()
    expect(registry.getDevice(otherChild!.deviceId)).not.toBeNull()
    await closed
  })

  it('renames a child in place and rejects duplicate or too many phones', async () => {
    const { server, registry, userDataPath } = await startServer()
    const desktop = pairDesktop(server)
    const [child] = await sync(desktop, [{ phoneKey: 'p', name: 'iPhone via MacBook' }])
    expect(await sync(desktop, [{ phoneKey: 'p', name: 'iPad via MacBook' }])).toEqual([child])
    expect(new DeviceRegistry(userDataPath).getDevice(child!.deviceId)?.name).toBe(
      'iPad via MacBook'
    )

    const tooMany = Array.from({ length: 33 }, (_, index) => ({ phoneKey: `p${index}`, name: 'n' }))
    for (const phones of [
      [
        { phoneKey: 'p', name: 'a' },
        { phoneKey: 'p', name: 'b' }
      ],
      tooMany
    ]) {
      await expect(sendSync(desktop, phones)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    expect(registry.listDelegatedMobileDevices(desktop.pairedDeviceId!)).toHaveLength(1)
  })

  it('keeps the parent when a child cleanup cannot be saved', async () => {
    const { server, registry } = await startServer()
    const desktop = pairDesktop(server)
    const [child] = await sync(desktop, [{ phoneKey: 'p', name: 'p' }])
    expect(
      server.setMobileRelayBinding(child!.deviceId, {
        relayHostId: 'host',
        relayDeviceId: child!.deviceId,
        ownerIdentityKey: 'owner'
      })
    ).toBe(true)
    const enqueue = vi.spyOn(server.getRelayRevokeOutbox(), 'enqueue').mockImplementation(() => {
      throw new Error('disk full')
    })
    cleanups.push(() => enqueue.mockRestore())

    expect(server.revokeRuntimeAccess(desktop.pairedDeviceId!)).toBe(false)
    expect(registry.getDevice(desktop.pairedDeviceId!)).not.toBeNull()
    expect(registry.getDevice(child!.deviceId)).not.toBeNull()
  })

  it('fails a sync whose dropped child cannot be revoked, keeping that child', async () => {
    const { server, registry } = await startServer()
    const desktop = pairDesktop(server)
    const [child] = await sync(desktop, [{ phoneKey: 'p', name: 'p' }])
    expect(
      server.setMobileRelayBinding(child!.deviceId, {
        relayHostId: 'host',
        relayDeviceId: child!.deviceId,
        ownerIdentityKey: 'owner'
      })
    ).toBe(true)
    const enqueue = vi.spyOn(server.getRelayRevokeOutbox(), 'enqueue').mockImplementation(() => {
      throw new Error('disk full')
    })
    cleanups.push(() => enqueue.mockRestore())

    await expect(sendSync(desktop, [{ phoneKey: 'q', name: 'q' }])).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_error', message: 'delegated_device_revoke_failed' }
    })
    expect(registry.listDelegatedMobileDevices(desktop.pairedDeviceId!)).toMatchObject([
      { deviceId: child!.deviceId }
    ])
  })

  it('keeps the parent link across a restart, so the cascade still applies', async () => {
    const first = await startServer()
    const desktop = pairDesktop(first.server)
    const [child] = await sync(desktop, [{ phoneKey: 'p', name: 'p' }])
    await first.server.stop()

    const reloaded = new DeviceRegistry(first.userDataPath)
    expect(reloaded.listDelegatedMobileDevices(desktop.pairedDeviceId!)).toMatchObject([
      { deviceId: child!.deviceId, phoneKey: 'p', parentDeviceId: desktop.pairedDeviceId }
    ])
    const { server, registry } = await startServer(first.userDataPath)
    expect(server.revokeRuntimeAccess(desktop.pairedDeviceId!)).toBe(true)
    expect(registry.getDevice(child!.deviceId)).toBeNull()
  })

  it('loads a registry written before delegated devices existed unchanged', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-delegated-old-'))
    const old = [
      { deviceId: 'd1', name: 'Phone', token: 't1', scope: 'mobile', pairedAt: 1, lastSeenAt: 2 },
      { deviceId: 'd2', name: 'Mac', token: 't2', scope: 'runtime', pairedAt: 3, lastSeenAt: 4 }
    ]
    writeFileSync(join(userDataPath, DEVICE_REGISTRY_FILENAME), JSON.stringify(old))
    const registry = new DeviceRegistry(userDataPath)
    expect(registry.listDevices()).toMatchObject(old)
    expect(registry.listDevices().every((device) => device.parentDeviceId === undefined)).toBe(true)
    expect(registry.listDelegatedMobileDevices('d2')).toEqual([])
  })
})
