import * as ExpoCrypto from 'expo-crypto'
import { z } from 'zod'
import {
  EXCHANGE_PAIRING_TICKET_METHOD,
  PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY
} from '../../../src/shared/remote-runtime/pairing/ticket-exchange-capability'
import type { HostStatusReply } from './host-status-reply-schema'
import type { PairingCandidateClient } from './mobile-relay-physical-client'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import type { PairingRelayLogger } from './pairing-relay-log'
import { bindDeferredRpcOperation, defineRpcOperation } from './rpc-operation'
import { rpcResultVariant } from './rpc-operation-result-reader'

export const pairingTicketExchange = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'pairing.exchange-ticket',
    method: EXCHANGE_PAIRING_TICKET_METHOD,
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ticket-exchanged', z.object({ deviceId: z.string().min(1) }))
  })
)

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Swap the scanned pairing code for a token generated on this phone, so the code shown on the
 * desktop stops working once this phone signs in with its own token. The desktop keeps
 * accepting the scanned code until then, so every failure here just keeps today's behaviour.
 */
export async function exchangePairingTicket(args: {
  client: PairingCandidateClient
  status: HostStatusReply | null
  ticket: string
  log: PairingRelayLogger
  randomBytes?: (length: number) => Uint8Array
}): Promise<string> {
  if (!args.status?.capabilities?.includes(PAIRING_TICKET_EXCHANGE_RUNTIME_CAPABILITY)) {
    return args.ticket
  }
  const deviceToken = toHex((args.randomBytes ?? ExpoCrypto.getRandomBytes)(24))
  try {
    pairingTicketExchange.interpret(
      await pairingTicketExchange.request(args.client, { deviceToken })
    )
    args.log('info', 'Pairing code exchanged for a token held only by this phone')
    return deviceToken
  } catch (error) {
    args.log(
      'info',
      'Keeping the scanned pairing code',
      error instanceof Error ? error.message : String(error)
    )
    return args.ticket
  }
}

/**
 * Recovery republishes from the journal, so it must hold the exchanged token before the host does.
 * If that write fails, keep the scanned token everywhere: the desktop still accepts it.
 */
export async function adoptExchangedToken(
  journal: MobileRelayPairingJournal,
  deviceToken: string,
  saveJournal: (journal: MobileRelayPairingJournal) => Promise<void>
): Promise<MobileRelayPairingJournal> {
  if (deviceToken === journal.secrets.deviceToken) {
    return journal
  }
  const exchanged = { ...journal, secrets: { ...journal.secrets, deviceToken } }
  try {
    await saveJournal(exchanged)
    return exchanged
  } catch {
    return journal
  }
}
