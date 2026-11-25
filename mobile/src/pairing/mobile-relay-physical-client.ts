import type { PairingRelay } from '../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { connectRelayRpcClient } from '../../../src/shared/remote-runtime/relay/client/relay-rpc-client'
import { relayConnectWebSocketUrl } from '../../../src/shared/remote-runtime/relay/client/relay-connect-url'
import {
  createPairingRelayLogger,
  pairingRelayErrorDetail
} from '../diagnostics/connection/pairing-relay-log'
import { redactSocketEndpoint } from '../diagnostics/connection/socket-event-debug'
import type { ConnectionLogSink } from '../diagnostics/connection/connection-log-types'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { MOBILE_RELAY_CLIENT_PLATFORM } from '../transport/encryption/mobile-relay-client-platform'

export type PairingCandidateClient = {
  sendRequest(method: string, params?: unknown): Promise<RpcResponse>
  close(): void
}

export function connectMobileRelayForPairing(args: {
  relay: PairingRelay
  deviceToken: string
  desktopPublicKeyB64: string
  credential?: string
  expectedCredentialKind?: 'invite' | 'resume'
  requestTimeoutMs?: number
  onLog?: ConnectionLogSink
}): PairingCandidateClient {
  const log = createPairingRelayLogger(args.onLog)
  const cellHost = redactSocketEndpoint(
    relayConnectWebSocketUrl(args.relay.cellUrl, args.relay.relayHostId)
  )
  log('info', 'Relay: dialing cell', cellHost)
  return connectRelayRpcClient(
    {
      platform: MOBILE_RELAY_CLIENT_PLATFORM,
      endpoint: args.relay,
      credential: args.credential ?? args.relay.inviteToken,
      expectedCredentialKind: args.expectedCredentialKind ?? 'invite',
      authCredential: { kind: 'token', deviceToken: args.deviceToken },
      desktopPublicKeyB64: args.desktopPublicKeyB64,
      requestTimeoutMs: args.requestTimeoutMs
    },
    {
      onOpen: () => log('info', 'Relay: cell socket open', 'Sending relay credential'),
      onHello: () => log('info', 'Relay: cell accepted credential', 'Starting E2EE handshake'),
      onAuthenticated: () => log('success', 'Relay: authenticated', 'Channel ready for RPC'),
      onClosed: (error, intentional) =>
        intentional
          ? log('info', 'Relay: pairing socket closed', cellHost)
          : log('warn', 'Relay: pairing socket closed', pairingRelayErrorDetail(error))
    }
  )
}
