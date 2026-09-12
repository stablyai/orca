import { parsePairingInput } from './pairing'
import { pairingRejectionMessage } from './pairing-rejection-message'
import type { PairingOffer } from './types'

export type PairConfirmRouteState =
  | { kind: 'ready'; offer: PairingOffer; errorMessage: '' }
  | { kind: 'error'; offer: null; errorMessage: string }

export function resolvePairConfirmRouteState(code: string | undefined): PairConfirmRouteState {
  if (!code) {
    return { kind: 'error', offer: null, errorMessage: 'Missing pairing code' }
  }

  const result = parsePairingInput(code)
  if (!result.ok) {
    return {
      kind: 'error',
      offer: null,
      errorMessage: pairingRejectionMessage(result.rejection, 'deep-link')
    }
  }

  return { kind: 'ready', offer: result.offer, errorMessage: '' }
}
