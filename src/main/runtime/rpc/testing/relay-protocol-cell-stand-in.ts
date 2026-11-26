// A stand-in Relay cell that speaks the cell's protocol: a client's relay-auth and hello, the host's
// data socket for each admitted connection, then the same splicing and limits as the real cell.
import { WebSocketServer, type WebSocket } from 'ws'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../../shared/remote-runtime/relay/mobile-relay-close-codes'
import type { RelayPhoneHello } from '../../../../shared/remote-runtime/relay/mobile-relay-phone-protocol'
import { createCellSplicer, type RelayCellStandIn } from './relay-cell-stand-in'

const HOST_ATTACH_WAIT_MS = 5_000

export type RelayCellAdmission = {
  /** The host is asked to dial `/v1/host/data/<connId>` for this connection. */
  connId: string
  hello: Extract<RelayPhoneHello, { ok: true }>
}

export async function startRelayProtocolCellStandIn(args: {
  /** Null refuses the credential, as the cell does an unknown or spent one; a code closes with it. */
  admit: (credential: string) => RelayCellAdmission | null | { closeCode: number }
}): Promise<RelayCellStandIn & { credentials: string[] }> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 8 * 1024 * 1024 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('stand-in cell has no port')
  }
  const splicer = createCellSplicer()
  const hostWaiters = new Map<string, (host: WebSocket) => void>()
  const credentials: string[] = []

  server.on('connection', (socket, request) => {
    const path = request.url ?? ''
    if (path.startsWith('/v1/host/data/')) {
      const connId = decodeURIComponent(path.slice('/v1/host/data/'.length))
      // The host's first frame is its data auth; then the socket carries the client's traffic.
      socket.once('message', () => hostWaiters.get(connId)?.(socket))
      return
    }
    if (!path.startsWith('/v1/connect/')) {
      socket.terminate()
      return
    }
    socket.once('message', (raw) => {
      const auth: unknown = JSON.parse(raw.toString())
      const credential =
        auth && typeof auth === 'object' && 'credential' in auth ? String(auth.credential) : ''
      credentials.push(credential)
      const admitted = args.admit(credential)
      if (admitted && 'closeCode' in admitted) {
        socket.close(admitted.closeCode, 'refused')
        return
      }
      if (!admitted) {
        const code = MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL
        socket.send(JSON.stringify({ type: 'relay-hello', ok: false, code }))
        socket.close(code, 'bad credential')
        return
      }
      const timer = setTimeout(() => {
        hostWaiters.delete(admitted.connId)
        socket.close(MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE, 'host did not attach')
      }, HOST_ATTACH_WAIT_MS)
      hostWaiters.set(admitted.connId, (host) => {
        clearTimeout(timer)
        hostWaiters.delete(admitted.connId)
        socket.send(JSON.stringify(admitted.hello))
        splicer.splice(socket, host)
      })
    })
  })

  return {
    url: `ws://127.0.0.1:${address.port}`,
    credentials,
    limitCloses: splicer.limitCloses,
    cut: splicer.cut,
    stallClient: splicer.stallClient,
    close: async () => {
      splicer.cut()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
