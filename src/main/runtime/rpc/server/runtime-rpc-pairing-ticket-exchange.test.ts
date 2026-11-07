import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  EXCHANGE_PAIRING_TICKET_METHOD,
  PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY
} from '../../../../shared/remote-runtime/pairing/ticket-exchange-capability'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { devicePrincipalOf } from './pairing/device-principal'
import { DeviceRegistry } from './pairing/device-registry'
import type { DeviceEntry } from './pairing/device-entry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { AuthenticatedMobileSocket } from '../mobile-socket-wiring'

const REPLACEMENT = 'c'.repeat(48)

function serverWithPairedPhone() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-ticket-exchange-rpc-'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: status.get only reads these three members.
  const runtime = {
    configureNotificationDismissalStore: () => {},
    getRuntimeId: () => 'test-runtime',
    getStatus: vi.fn().mockResolvedValue({ graphStatus: 'ok' })
  } as unknown as OrcaRuntimeService
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  const registry = new DeviceRegistry(userDataPath)
  server['deviceRegistry'] = registry
  const phone = registry.getOrCreatePendingDevice('Phone', 'mobile')
  registry.updateLastSeen(phone.deviceId)
  const socketFor = (device: DeviceEntry): AuthenticatedMobileSocket => ({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only uses ws as a map key for abort registration.
    ws: {} as AuthenticatedMobileSocket['ws'],
    connectionId: `connection-${device.deviceId}`,
    transcriptHashB64: Buffer.alloc(32).toString('base64'),
    device: { ...devicePrincipalOf(device), deviceToken: device.token },
    clientCapabilities: [],
    transport: { transport: 'direct' }
  })
  const send = async (socket: AuthenticatedMobileSocket, request: Record<string, unknown>) => {
    const replies: string[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify(request),
      (response) => replies.push(response),
      () => {},
      undefined,
      undefined,
      socket.device.deviceToken ?? null,
      socket
    )
    const reply: unknown = JSON.parse(replies.at(-1)!)
    return reply
  }
  return { registry, phone, socketFor, send }
}

describe(EXCHANGE_PAIRING_TICKET_METHOD, () => {
  it('is advertised and lets a phone on its pairing token propose a replacement', async () => {
    const { registry, phone, socketFor, send } = serverWithPairedPhone()
    const ticketSocket = socketFor(phone)

    expect(RUNTIME_CAPABILITIES).toContain(PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY)

    const reply = await send(ticketSocket, {
      id: 'x',
      method: EXCHANGE_PAIRING_TICKET_METHOD,
      params: { deviceToken: REPLACEMENT }
    })
    expect(reply).toMatchObject({ ok: true, result: { deviceId: phone.deviceId } })

    const replaced = registry.validateToken(REPLACEMENT)!
    const again = {
      method: EXCHANGE_PAIRING_TICKET_METHOD,
      params: { deviceToken: 'e'.repeat(48) }
    }
    // The socket still on the pairing token is cut on its next request.
    expect(await send(ticketSocket, { id: 'old', ...again })).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' }
    })
    // The replacement socket is authenticated; there is just nothing left to exchange.
    expect(await send(socketFor(replaced), { id: 'new', ...again })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('not_a_ticket') }
    })
  })

  it('refuses malformed replacements and a second exchange', async () => {
    const { registry, phone, socketFor, send } = serverWithPairedPhone()
    expect(
      await send(socketFor(phone), {
        id: 'bad',
        method: EXCHANGE_PAIRING_TICKET_METHOD,
        params: { deviceToken: 'short' }
      })
    ).toMatchObject({ ok: false })

    await send(socketFor(phone), {
      id: 'x',
      method: EXCHANGE_PAIRING_TICKET_METHOD,
      params: { deviceToken: REPLACEMENT }
    })
    const replaced = registry.validateToken(REPLACEMENT)!
    expect(
      await send(socketFor(replaced), {
        id: 'again',
        method: EXCHANGE_PAIRING_TICKET_METHOD,
        params: { deviceToken: 'd'.repeat(48) }
      })
    ).toMatchObject({ ok: false })
    expect(registry.validateToken(REPLACEMENT)?.deviceId).toBe(phone.deviceId)
  })
})
