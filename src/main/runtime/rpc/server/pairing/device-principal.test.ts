import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { devicePrincipalOf } from './device-principal'
import { DeviceRegistry } from './device-registry'

import type { DeviceEntry } from './device-entry'
import './mobile-pairing-files'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import type { AuthenticatedMobileSocket } from '../../mobile-socket-wiring'

function socketFor(device: DeviceEntry): AuthenticatedMobileSocket {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only uses ws as a map key for abort registration.
    ws: {} as AuthenticatedMobileSocket['ws'],
    connectionId: 'connection-1',
    transcriptHashB64: null,
    device: { ...devicePrincipalOf(device), deviceToken: device.token },
    clientCapabilities: [],
    transport: { transport: 'direct' }
  }
}

describe('device principal', () => {
  it('dispatches an old phone with its token as client id and refuses it once re-credentialed', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-principal-rpc-'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: status.get only reads these three members.
    const runtime = {
      configureNotificationDismissalStore: () => {},
      getRuntimeId: () => 'test-runtime',
      getStatus: vi.fn().mockResolvedValue({ graphStatus: 'ok' })
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    const registry = new DeviceRegistry(userDataPath)
    server['deviceRegistry'] = registry
    const phone = registry.addDevice('phone', 'mobile')
    const socket = socketFor(phone)
    const dispatch = vi.spyOn(server['dispatcher'], 'dispatchStreaming')

    const replies: string[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'r1', method: 'status.get' }),
      (response) => replies.push(response),
      () => {},
      undefined,
      undefined,
      phone.token,
      socket
    )
    expect(dispatch.mock.calls[0]?.[2]).toMatchObject({
      clientId: phone.token,
      pairedDeviceId: phone.deviceId,
      authenticatedCallerFingerprint: createHash('sha256').update(phone.token).digest('hex')
    })

    registry['devices'] = registry['devices'].map((row) => ({ ...row, credentialRevision: 1 }))
    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'r2', method: 'status.get' }),
      (response) => replies.push(response),
      () => {},
      undefined,
      undefined,
      phone.token,
      socket
    )
    expect(dispatch).toHaveBeenCalledOnce()
    expect(JSON.parse(replies.at(-1)!)).toMatchObject({
      id: 'r2',
      ok: false,
      error: { code: 'unauthorized' }
    })
  })
})
