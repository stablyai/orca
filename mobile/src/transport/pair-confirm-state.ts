import { parsePairingCode } from './pairing'
import type { PairingOffer } from './types'
import { getUnsupportedPairingTransportMessage } from '../../../src/shared/pairing-transport-support'

export type PairConfirmRouteState =
  | { kind: 'ready'; offer: PairingOffer; errorMessage: '' }
  | { kind: 'error'; offer: null; errorMessage: string }

export function resolvePairConfirmRouteState(code: string | undefined): PairConfirmRouteState {
  if (!code) {
    return { kind: 'error', offer: null, errorMessage: 'Missing pairing code' }
  }

  const offer = parsePairingCode(code)
  if (!offer) {
    return { kind: 'error', offer: null, errorMessage: 'Not a valid pairing code' }
  }
  const unsupportedTransport = getUnsupportedPairingTransportMessage(offer)
  if (unsupportedTransport) {
    return { kind: 'error', offer: null, errorMessage: unsupportedTransport }
  }

  return { kind: 'ready', offer, errorMessage: '' }
}
