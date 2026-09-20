import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as secureFile from '../../shared/secure-file'
import { encodePairingOffer, parsePairingCode } from '../../shared/pairing'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'
import { RpcDispatcher } from './rpc/dispatcher'
import { DeviceRegistry } from './device-registry'
import {
  authenticateMobileWsSession,
  connectWs,
  createEncryptedWsResponseReader,
  nextWsMessage,
  sendEncryptedWsRequest,
  waitForWsClose
} from './runtime-rpc-mobile-ws-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { readRuntimeMetadata } from './runtime-metadata'
import { sendRequest } from './runtime-rpc-test-harness'

describe('local runtime access administration', () => {
  let userDataPath: string
  let server: OrcaRuntimeRpcServer

  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-access-'))
    server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function request(method: string, params: unknown = {}) {
    const metadata = readRuntimeMetadata(userDataPath)!
    const endpoint = metadata.transports.find((transport) => transport.kind !== 'websocket')!
    return sendRequest(endpoint.endpoint, {
      id: 'admin',
      authToken: metadata.authToken,
      method,
      params
    })
  }

  it('lists only runtime grants and never exposes credentials', async () => {
    const offer = server.createPairingOffer({
      name: 'Shared workstation',
      scope: 'runtime',
      address: '127.0.0.1'
    })
    if (!offer.available) {
      throw new Error('Pairing unavailable')
    }
    server.createPairingOffer({ name: 'Phone', scope: 'mobile', address: '127.0.0.1' })
    const device = server.getDeviceRegistry()!.getDevice(offer.deviceId)!
    const response = await request('runtimeAccess.list')
    expect(response).toMatchObject({ ok: true })
    expect(response.result).toEqual({
      grants: [
        {
          deviceId: offer.deviceId,
          name: device.name,
          createdAt: device.pairedAt,
          lastSeenAt: null
        }
      ]
    })
    expect(JSON.stringify(response)).not.toContain(device.token)
  })

  it('rejects invalid local authentication', async () => {
    const metadata = readRuntimeMetadata(userDataPath)!
    const endpoint = metadata.transports.find((transport) => transport.kind !== 'websocket')!
    for (const method of ['runtimeAccess.list', 'runtimeAccess.revoke']) {
      expect(
        await sendRequest(endpoint.endpoint, {
          id: 'bad-auth',
          authToken: 'invalid',
          method,
          params: { deviceId: 'forged' }
        })
      ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    }
  })

  it('does not infer administrative authority from an absent clientKind or request fields', async () => {
    const dispatcher = new RpcDispatcher({ runtime: new OrcaRuntimeService() })
    const device = server.getDeviceRegistry()!.addDevice('Retained', 'runtime')
    for (const options of [undefined, { clientKind: 'runtime' as const }]) {
      for (const method of ['runtimeAccess.list', 'runtimeAccess.revoke']) {
        const forged = {
          id: 'forged',
          authToken: 'unused',
          method,
          params: { deviceId: device.deviceId },
          runtimeAccess: { revoke: true },
          clientKind: undefined
        }
        expect(await dispatcher.dispatch(forged, options)).toMatchObject({
          ok: false,
          error: { code: 'forbidden' }
        })
      }
    }
    expect(server.getDeviceRegistry()!.validateToken(device.token)).not.toBeNull()
  })

  it.each(['runtime', 'mobile'] as const)(
    'denies administrative calls from paired %s WebSockets',
    async (scope) => {
      const offer = server.createPairingOffer({ scope, address: '127.0.0.1' })
      if (!offer.available) {
        throw new Error('Pairing unavailable')
      }
      const victim = server.getDeviceRegistry()!.addDevice('Victim', 'runtime')
      const session = await authenticateMobileWsSession(offer.pairingUrl)
      const reader = createEncryptedWsResponseReader(session)
      try {
        for (const method of ['runtimeAccess.list', 'runtimeAccess.revoke']) {
          sendEncryptedWsRequest(session, {
            id: method,
            method,
            params: { deviceId: victim.deviceId },
            runtimeAccess: { revoke: true }
          })
          expect(await reader.next(method)).toMatchObject({
            ok: false,
            error: { code: 'forbidden' }
          })
        }
        expect(server.getDeviceRegistry()!.validateToken(victim.token)).not.toBeNull()
      } finally {
        reader.dispose()
        session.ws.close()
        await waitForWsClose(session.ws)
      }
    }
  )

  it('revokes one grant, disconnects idle clients, and rejects its credential after restart', async () => {
    const offer = server.createPairingOffer({ scope: 'runtime', address: '127.0.0.1' })
    if (!offer.available) {
      throw new Error('Pairing unavailable')
    }
    const parsed = parsePairingCode(offer.pairingUrl)!
    const first = await authenticateMobileWsSession(offer.pairingUrl)
    const second = await authenticateMobileWsSession(offer.pairingUrl)
    const registry = server.getDeviceRegistry()!
    const sibling = registry.addDevice('Sibling', 'runtime')
    const phone = registry.addDevice('Phone', 'mobile')
    registry.setRelayBinding(phone.deviceId, {
      relayHostId: 'fixture-host',
      relayDeviceId: phone.deviceId,
      ownerIdentityKey: 'fixture-owner'
    })
    const beforeRevoke = new DeviceRegistry(userDataPath)
    registry.updateLastSeenDeferred(offer.deviceId)
    expect(await request('runtimeAccess.revoke', { deviceId: offer.deviceId })).toMatchObject({
      ok: true,
      result: { revoked: true }
    })
    await Promise.all([waitForWsClose(first.ws), waitForWsClose(second.ws)])
    expect(await request('runtimeAccess.revoke', { deviceId: offer.deviceId })).toMatchObject({
      ok: false,
      error: { code: 'runtime_access_not_found' }
    })
    registry.flushPendingLastSeen()
    const reloaded = new DeviceRegistry(userDataPath)
    expect(reloaded.validateToken(parsed.deviceToken)).toBeNull()
    expect(reloaded.getDevice(sibling.deviceId)).toEqual(beforeRevoke.getDevice(sibling.deviceId))
    expect(reloaded.getDevice(phone.deviceId)).toEqual(beforeRevoke.getDevice(phone.deviceId))
    await server.stop()
    server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    const ws = await connectWs(server.getWebSocketEndpoint()!)
    const keys = generateKeyPair()
    const sharedKey = deriveSharedKey(
      keys.secretKey,
      Uint8Array.from(Buffer.from(parsed.publicKeyB64, 'base64'))
    )
    ws.send(
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(keys.publicKey).toString('base64')
      })
    )
    expect(JSON.parse(await nextWsMessage(ws))).toEqual({ type: 'e2ee_ready' })
    ws.send(
      encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: parsed.deviceToken }), sharedKey)
    )
    expect(JSON.parse(decrypt(await nextWsMessage(ws), sharedKey)!)).toMatchObject({
      type: 'e2ee_error',
      error: { code: 'unauthorized' }
    })
    ws.close()
    await waitForWsClose(ws)
    const retainedSession = await authenticateMobileWsSession(
      encodePairingOffer({
        ...parsed,
        endpoint: server.getWebSocketEndpoint()!,
        deviceToken: sibling.token,
        pairedDeviceId: sibling.deviceId
      })
    )
    retainedSession.ws.close()
    await waitForWsClose(retainedSession.ws)
  }, 15_000)

  it('rejects missing, malformed, unknown and mobile IDs without touching grants', async () => {
    const registry = server.getDeviceRegistry()!
    const phone = registry.addDevice('Phone', 'mobile')
    for (const params of [
      {},
      { deviceId: '' },
      { deviceId: 'prefix' },
      { deviceId: phone.deviceId, all: true }
    ]) {
      expect(await request('runtimeAccess.revoke', params)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    }
    for (const deviceId of [phone.deviceId, '00000000-0000-4000-8000-000000000000']) {
      expect(await request('runtimeAccess.revoke', { deviceId })).toMatchObject({
        ok: false,
        error: { code: 'runtime_access_not_found' }
      })
    }
    expect(registry.getDevice(phone.deviceId)).toEqual(phone)
  })

  it('reports a failed persistent write and leaves the credential valid', async () => {
    const registry = server.getDeviceRegistry()!
    const device = registry.addDevice('Retained', 'runtime')
    vi.spyOn(secureFile, 'writeSecureJsonFile').mockImplementation(() => {
      throw new Error('ENOSPC: fixture disk full at /fixture/private/device-registry.json')
    })
    expect(await request('runtimeAccess.revoke', { deviceId: device.deviceId })).toMatchObject({
      ok: false,
      error: {
        code: 'runtime_error',
        message: 'Unexpected runtime error.'
      }
    })
    expect(registry.validateToken(device.token)).not.toBeNull()
  })
})
