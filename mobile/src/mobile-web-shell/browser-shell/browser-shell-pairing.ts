import {
  PairingOfferSchema,
  type PairingOffer
} from '../../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { parsePairingCode } from '../../pairing/pairing'
import {
  BROWSER_SHELL_PAIRING_HASH_PARAM as PAIRING_HASH_PARAM,
  BROWSER_SHELL_PAIRING_STORAGE_KEY as PAIRING_STORAGE_KEY
} from './browser-shell-presence'

export type BrowserShellPairing =
  | { kind: 'paired'; offer: PairingOffer; fromLink: boolean }
  | { kind: 'refused'; reason: string }
  | { kind: 'none' }

/**
 * The offer from `#pairing=` in the link `orca serve` prints, else the one a previous visit kept.
 * The fragment is erased once read, so the credential does not stay in the address bar or history.
 */
export function readBrowserShellPairing(): BrowserShellPairing {
  const fromLink = new URLSearchParams(window.location.hash.slice(1)).get(PAIRING_HASH_PARAM)
  if (fromLink !== null) {
    history.replaceState(null, '', window.location.pathname + window.location.search)
    const offer = parsePairingCode(fromLink)
    if (offer === null) {
      return { kind: 'refused', reason: 'The pairing link is damaged.' }
    }
    if (offer.scope === 'runtime' || offer.relay !== undefined) {
      return {
        kind: 'refused',
        reason:
          'This link is not for a phone browser. Use the "Mobile web URL" from orca serve --mobile-pairing.'
      }
    }
    writeBrowserShellPairing(offer)
    return { kind: 'paired', offer, fromLink: true }
  }
  const stored = readStoredPairing()
  return stored === null ? { kind: 'none' } : { kind: 'paired', offer: stored, fromLink: false }
}

export function writeBrowserShellPairing(offer: PairingOffer): void {
  try {
    localStorage.setItem(PAIRING_STORAGE_KEY, JSON.stringify(offer))
  } catch {
    // Private windows refuse storage; the link still works for this visit.
  }
}

function readStoredPairing(): PairingOffer | null {
  try {
    const raw = localStorage.getItem(PAIRING_STORAGE_KEY)
    if (raw === null) {
      return null
    }
    const parsed = PairingOfferSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
