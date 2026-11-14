import '../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { PAIRING_METHODS } from '../../methods/pairing/pairing'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { readRuntimeMetadata } from '../runtime-metadata'
import { sendRequest } from '../runtime-rpc-test-harness'
import { parsePairingCode } from '../../../../../shared/remote-runtime/pairing/pairing'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from '../runtime-rpc-mobile-ws-test-harness'

const resources: { server: OrcaRuntimeRpcServer; directory: string }[] = []

afterEach(async () => {
  for (const { server, directory } of resources.splice(0)) {
    await server.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

async function start(pinnedBindHost: string | null = '127.0.0.1') {
  const directory = mkdtempSync(join(tmpdir(), 'orca-proxy-pairing-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    methods: PAIRING_METHODS,
    userDataPath: directory,
    enableWebSocket: true,
    ...(pinnedBindHost ? { pinnedBindHost } : {}),
    wsPort: 0
  })
  resources.push({ server, directory })
  await server.start()
  const metadata = readRuntimeMetadata(directory)!
  const request = (params: Record<string, unknown>) =>
    sendRequest(metadata.transports[0]!.endpoint, {
      id: 'proxy-offer',
      authToken: metadata.authToken,
      method: 'pairing.createOffer',
      params
    })
  return { server, request }
}

describe('owner pairing through a protected loopback proxy', () => {
  it.each(['runtime', 'mobile'] as const)(
    'mints a %s offer without rebinding, replacing other offers or disconnecting a client',
    async (scope) => {
      const { server, request } = await start()
      const endpoint = server.getWebSocketEndpoint()
      const existing = server.createPairingOffer({ address: endpoint, scope: 'runtime' })
      if (!existing.available) {
        throw new Error(existing.reason)
      }
      const session = await authenticateMobileWsSession(existing.pairingUrl)
      const reader = createEncryptedWsResponseReader(session)
      const unrelated = server.getDeviceRegistry()!.addDevice('pending network offer', scope)
      try {
        const response = await request({
          scope,
          preserveBind: true,
          address: 'https://orca.example.com'
        })
        expect(response.ok).toBe(true)
        const offer = z
          .object({ available: z.literal(true), pairingUrl: z.string(), deviceId: z.string() })
          .parse(response.result)
        expect(parsePairingCode(offer.pairingUrl)).toMatchObject({
          endpoint: 'wss://orca.example.com',
          scope
        })
        expect(server.getDeviceRegistry()!.getDevice(offer.deviceId)).toMatchObject({
          scope,
          pairingReach: 'this-computer'
        })
        expect(server.getDeviceRegistry()!.validateToken(unrelated.token)?.deviceId).toBe(
          unrelated.deviceId
        )
        const repeated = await request({
          scope,
          preserveBind: true,
          address: 'wss://orca.example.com'
        })
        expect(repeated.result).toMatchObject({ available: true, deviceId: offer.deviceId })
        expect(server.getWebSocketEndpoint()).toBe(endpoint)
        sendEncryptedWsRequest(session, {
          id: 'still-connected',
          method: 'pairing.createOffer',
          params: { scope: 'runtime', address: 'wss://orca.example.com', preserveBind: true }
        })
        expect(await reader.next('still-connected')).toMatchObject({
          ok: false,
          error: { code: 'forbidden' }
        })
      } finally {
        reader.dispose()
        session.ws.close()
      }
    }
  )

  it('refuses missing/insecure/local endpoints and Relay before issuing a credential', async () => {
    const { server, request } = await start()
    for (const address of [
      undefined,
      'ws://orca.example.com',
      'https://127.0.0.1',
      'https://orca.example.com?token=value'
    ]) {
      const response = await request({ scope: 'mobile', preserveBind: true, address })
      expect(response).toMatchObject({
        ok: true,
        result: { available: false, reason: 'invalid_advertised_endpoint' }
      })
    }
    expect(
      await request({
        scope: 'mobile',
        preserveBind: true,
        relay: true,
        address: 'https://orca.example.com'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(server.getDeviceRegistry()!.listDevices()).toEqual([])
  })

  it('does not use proxy pairing as implicit consent to expose an unpinned listener', async () => {
    const { server, request } = await start(null)
    expect(
      await request({ scope: 'runtime', preserveBind: true, address: 'https://orca.example.com' })
    ).toMatchObject({
      ok: true,
      result: { available: false, reason: 'invalid_advertised_endpoint' }
    })
    expect(server.getDeviceRegistry()!.listDevices()).toEqual([])
  })
})
