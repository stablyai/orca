import { parsePairingCode } from './pairing'
import type { PairingOffer } from './types'
import { t } from '@/i18n/mobile-i18n'

export type PairConfirmRouteState =
  | { kind: 'ready'; offer: PairingOffer; errorMessage: '' }
  | { kind: 'error'; offer: null; errorMessage: string }

export function resolvePairConfirmRouteState(code: string | undefined): PairConfirmRouteState {
  if (!code) {
    return { kind: 'error', offer: null, errorMessage: t('m.WABgCvg') }
  }

  const offer = parsePairingCode(code)
  if (!offer) {
    return { kind: 'error', offer: null, errorMessage: t('m.gx2zC4w') }
  }

  return { kind: 'ready', offer, errorMessage: '' }
}
