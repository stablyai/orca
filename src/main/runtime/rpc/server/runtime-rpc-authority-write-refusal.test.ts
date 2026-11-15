import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as secureFile from '../../../../shared/secure-storage/secure-file'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from './runtime-rpc-mobile-ws-test-harness'

it('returns a retryable registry failure for an authenticated mutation, then accepts a valid retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-authority-write-rpc-'))
  let deviceId = '',
    token = ''
  const server: OrcaRuntimeRpcServer = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: directory,
    enableWebSocket: true,
    wsPort: 0,
    methods: [
      {
        name: 'test.registryWrite',
        permission: 'workspace',
        params: null,
        handler: () => {
          server
            .getDeviceRegistry()!
            .exchangePairingTicket(
              deviceId,
              token,
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
            )
          return null
        }
      }
    ]
  })
  await server.start()
  const offer = server.createPairingOffer({ address: '127.0.0.1', scope: 'runtime' })
  if (!offer.available) {
    throw new Error('Pairing unavailable')
  }
  deviceId = offer.deviceId
  token = server.getDeviceRegistry()!.getDevice(deviceId)!.token!
  const session = await authenticateMobileWsSession(offer.pairingUrl)
  const reader = createEncryptedWsResponseReader(session)
  const write = vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockImplementationOnce(() => {
    throw new Error('disk full')
  })
  try {
    sendEncryptedWsRequest(session, { id: 'failed', method: 'test.registryWrite' })
    expect(await reader.next('failed')).toMatchObject({
      ok: false,
      error: { code: 'registry_unavailable', data: { retryable: true } }
    })
    sendEncryptedWsRequest(session, { id: 'retried', method: 'test.registryWrite' })
    expect(await reader.next('retried')).toMatchObject({ ok: true, result: null })
  } finally {
    write.mockRestore()
    reader.dispose()
    session.ws.close()
    await server.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
