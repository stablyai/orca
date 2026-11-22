import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { PAIRING_OFFER_CREATOR_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/pairing/pairing-offer-creator-capability'
import {
  PAIRING_CREATE_OFFER_METHOD,
  type PairingCreateOfferParams,
  type PairingCreateOfferResult
} from '../../shared/remote-runtime/pairing/pairing-create-offer-contract'

/** The terminal this runs in, so a link minted from a paired client's terminal goes when that client is revoked. */
async function callerTerminal(
  client: RuntimeClient
): Promise<Pick<PairingCreateOfferParams, 'callerTerminalHandle'>> {
  const handle = process.env.ORCA_TERMINAL_HANDLE
  if (!handle) {
    return {}
  }
  const status = await client.call<RuntimeStatus>('status.get')
  return status.result.capabilities?.includes(PAIRING_OFFER_CREATOR_RUNTIME_CAPABILITY)
    ? { callerTerminalHandle: handle }
    : {}
}

export function formatPairingOffer(offer: PairingCreateOfferResult): string {
  if (!offer.available) {
    return `Pairing is unavailable (${offer.reason}). ${offer.guidance}`
  }
  const lines: string[] = []
  if (offer.scope === 'mobile') {
    if (offer.qr) {
      lines.push(offer.qr.trimEnd(), '')
    }
    lines.push('Scan with Orca Mobile (Pair), or paste this link:', offer.pairingUrl)
  } else {
    lines.push(
      'Paste this link in Orca: Settings → Remote Orca Servers → Add Server.',
      offer.pairingUrl
    )
    if (offer.webClientUrl) {
      lines.push('', 'Or open it in a browser:', offer.webClientUrl)
    }
  }
  if (offer.endpoint) {
    lines.push('', `The client will connect to ${offer.endpoint}.`)
  }
  lines.push('Treat the link like a password: it grants access to this Orca.')
  return lines.join('\n')
}

export const PAIR_HANDLERS: Record<string, CommandHandler> = {
  pair: async ({ client, flags, json }) => {
    const mobile = flags.get('mobile') === true
    if (flags.get('relay') === true && !mobile) {
      throw new RuntimeClientError('invalid_argument', '--relay applies only with --mobile')
    }
    if (flags.get('grant-desktop-control') === true && mobile) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--grant-desktop-control applies only to an access link, not --mobile'
      )
    }
    const params: PairingCreateOfferParams = {
      scope: mobile ? 'mobile' : 'runtime',
      address: getOptionalStringFlag(flags, 'address'),
      relay: flags.get('relay') === true,
      grantDesktopControl: flags.get('grant-desktop-control') === true,
      rotate: flags.get('rotate') === true,
      ...(await callerTerminal(client))
    }
    const response = await client.call<PairingCreateOfferResult>(
      PAIRING_CREATE_OFFER_METHOD,
      params
    )
    printResult(response, json, formatPairingOffer)
    if (!response.result.available) {
      process.exitCode = 1
    }
  }
}
