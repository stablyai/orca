import type { PairingRelay } from '../../../src/shared/mobile-relay-pairing-offer'
import { RelayMovedSchema } from '../../../src/shared/mobile-relay-phone-protocol'

export class RelayDirectorMoveNotNewerError extends Error {
  readonly cellUrl: string
  readonly assignmentEpoch: number
  readonly currentCellUrl: string
  readonly currentAssignmentEpoch: number

  constructor(args: {
    cellUrl: string
    assignmentEpoch: number
    currentCellUrl: string
    currentAssignmentEpoch: number
  }) {
    super('relay director move was not strictly newer')
    this.name = 'RelayDirectorMoveNotNewerError'
    this.cellUrl = args.cellUrl
    this.assignmentEpoch = args.assignmentEpoch
    this.currentCellUrl = args.currentCellUrl
    this.currentAssignmentEpoch = args.currentAssignmentEpoch
  }
}

export function resolvePairingInviteThroughDirector(args: {
  relay: PairingRelay
  timeoutMs?: number
  createSocket?: (url: string) => WebSocket
}): Promise<PairingRelay> {
  const socket = (args.createSocket ?? ((url) => new WebSocket(url)))(
    directorWebSocketUrl(args.relay)
  )
  return new Promise((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(
      () => finish(new Error('relay director resolution timed out')),
      args.timeoutMs ?? 5_000
    )
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'relay-auth',
          v: 1,
          mode: 'connect',
          credential: args.relay.inviteToken
        })
      )
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        finish(new Error('invalid relay director move'))
        return
      }
      let value: unknown
      try {
        value = JSON.parse(event.data)
      } catch {
        finish(new Error('invalid relay director move'))
        return
      }
      const moved = RelayMovedSchema.safeParse(value)
      if (!moved.success) {
        finish(new Error('invalid relay director move'))
        return
      }
      if (moved.data.assignmentEpoch <= args.relay.assignmentEpoch) {
        finish(
          new RelayDirectorMoveNotNewerError({
            cellUrl: moved.data.cellUrl,
            assignmentEpoch: moved.data.assignmentEpoch,
            currentCellUrl: args.relay.cellUrl,
            currentAssignmentEpoch: args.relay.assignmentEpoch
          })
        )
        return
      }
      settled = true
      clearTimeout(timeout)
      socket.close()
      resolve({
        ...args.relay,
        cellUrl: moved.data.cellUrl,
        assignmentEpoch: moved.data.assignmentEpoch
      })
    }
    socket.onerror = () => finish(new Error('relay director transport error'))
    socket.onclose = (event) => {
      if (!settled) {
        finish(new Error(`relay director closed before move: ${event.code || 1006}`))
      }
    }

    function finish(error: Error): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      socket.close()
      reject(error)
    }
  })
}

export function directorWebSocketUrl(relay: PairingRelay): string {
  const url = new URL(relay.directorUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relay.relayHostId)}`
  return url.toString()
}
