import { translate } from '../i18n/mobile-i18n'
import { parsePairingCode } from './pairing'
import type { PairingOffer } from './types'

export type PairConfirmRouteState =
  | { kind: 'ready'; offer: PairingOffer; errorMessage: '' }
  | { kind: 'error'; offer: null; errorMessage: string }

export function resolvePairConfirmRouteState(
  code: string | string[] | undefined
): PairConfirmRouteState {
  if (!code) {
    return {
      kind: 'error',
      offer: null,
      errorMessage: translate('connection.pairConfirmState.missingCode', 'Missing pairing code')
    }
  }

  const offer = typeof code === 'string' ? parsePairingCode(code) : null
  if (!offer) {
    return {
      kind: 'error',
      offer: null,
      errorMessage: translate('connection.pairConfirmState.invalidCode', 'Not a valid pairing code')
    }
  }

  return { kind: 'ready', offer, errorMessage: '' }
}
