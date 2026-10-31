import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import {
  PAIRING_CREATE_OFFER_METHOD,
  type PairingCreateOfferParams,
  type PairingCreateOfferResult
} from '../../shared/pairing-create-offer-contract'

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
      rotate: flags.get('rotate') === true
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
