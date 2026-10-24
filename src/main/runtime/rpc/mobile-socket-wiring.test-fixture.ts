import { expect, vi, type Mock } from 'vitest'
import type { WebSocket } from 'ws'
import type { DeviceRegistry } from '../device-registry'
import type { MobileSocketTransport } from './mobile-socket-wiring'

export class FakeSocket {
  readonly OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  readonly sent: (string | Buffer)[] = []
  readonly send = vi.fn((data: string | Buffer) => this.sent.push(data))
  readonly close: Mock<WebSocket['close']> = vi.fn()
}

export class FakeTransport implements MobileSocketTransport {
  private messageHandler: Parameters<MobileSocketTransport['onMessage']>[0] | null = null
  private closeHandler: Parameters<MobileSocketTransport['onConnectionClose']>[0] | null = null
  readonly setClientId: Mock<MobileSocketTransport['setClientId']> = vi.fn()
  readonly terminateClientConnections = vi.fn(() => 0)

  onMessage(handler: Parameters<MobileSocketTransport['onMessage']>[0]): void {
    this.messageHandler = handler
  }

  onConnectionClose(handler: Parameters<MobileSocketTransport['onConnectionClose']>[0]): void {
    this.closeHandler = handler
  }

  receive(ws: FakeSocket, message: string): void {
    this.messageHandler?.(message, vi.fn(), ws as unknown as WebSocket)
  }

  disconnect(ws: FakeSocket): void {
    this.closeHandler?.(null, ws as unknown as WebSocket, false)
  }
}

export function registryFor(
  deviceId: string,
  token: string,
  scope: 'mobile' | 'runtime' = 'mobile'
): DeviceRegistry {
  return {
    validateToken: (candidate: string) =>
      candidate === token
        ? {
            deviceId,
            token,
            name: 'Phone',
            scope,
            pairedAt: 1,
            lastSeenAt: 0
          }
        : null,
    updateLastSeen: vi.fn(),
    updateLastSeenDeferred: vi.fn()
  } as unknown as DeviceRegistry
}

/** Real encrypted handshake; only the byte transport and token registry are test boundaries. */
export async function authenticatedDesktopSockets(
  deviceId: string,
  count: number,
  capabilities: number
) {
  const { MobileSocketWiring } = await import('./mobile-socket-wiring')
  const { generateKeyPair, deriveSharedKey, encrypt } = await import('../../../shared/e2ee-crypto')
  const desktop = generateKeyPair()
  const client = generateKeyPair()
  const transport = new FakeTransport()
  const advertised = [
    ...Array.from({ length: capabilities - 1 }, () => 'session-tabs.close-intent.v1' as const),
    'browser.clientHost.v1' as const
  ]
  const onText = vi.fn()
  const wiring = new MobileSocketWiring({
    deviceRegistry: registryFor(deviceId, 'fixture-token', 'runtime'),
    e2eeKeypair: { ...desktop, publicKeyB64: Buffer.from(desktop.publicKey).toString('base64') },
    onText,
    onBinary: () => {},
    onClose: () => {}
  })
  const detach = wiring.attachTransport(transport)
  const sockets = Array.from({ length: count }, () => new FakeSocket())
  const key = deriveSharedKey(client.secretKey, desktop.publicKey)
  for (const socket of sockets) {
    transport.receive(
      socket,
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: Buffer.from(client.publicKey).toString('base64')
      })
    )
    transport.receive(
      socket,
      encrypt(
        JSON.stringify({
          type: 'e2ee_auth',
          deviceToken: 'fixture-token',
          clientCapabilities: advertised
        }),
        key
      )
    )
    transport.receive(socket, encrypt('{"id":"fixture","method":"status.get"}', key))
  }
  expect(onText).toHaveBeenCalledTimes(count)
  for (const [socket] of onText.mock.calls) {
    expect(socket).toMatchObject({ device: { deviceId }, clientCapabilities: advertised })
  }
  return {
    wiring,
    disconnect: () => {
      for (const socket of sockets) {
        transport.disconnect(socket)
      }
    },
    close: () => {
      for (const socket of sockets) {
        transport.disconnect(socket)
      }
      detach()
      wiring.dispose()
    }
  }
}
