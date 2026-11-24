import type { PairingOffer } from '../../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { parsePairingCode } from '../../pairing/pairing'
import {
  BROWSER_SHELL_PAIRING_HASH_PARAM as PAIRING_HASH_PARAM,
  BROWSER_SHELL_PAIRING_STORAGE_KEY as PAIRING_STORAGE_KEY
} from './browser-shell-presence'

/**
 * The offer from `#pairing=` in the link `orca serve` prints, else the one a previous visit kept.
 * The fragment is erased once read, so the credential does not stay in the address bar or history.
 */
export function readBrowserShellPairing(): PairingOffer | null {
  const fromLink = new URLSearchParams(window.location.hash.slice(1)).get(PAIRING_HASH_PARAM)
  if (fromLink !== null) {
    const offer = parsePairingCode(fromLink)
    history.replaceState(null, '', window.location.pathname + window.location.search)
    if (offer !== null && offer.scope !== 'runtime' && offer.relay === undefined) {
      writeStoredPairing(fromLink)
      return offer
    }
    return null
  }
  const stored = readStoredPairing()
  return stored === null ? null : parsePairingCode(stored)
}

function readStoredPairing(): string | null {
  try {
    return localStorage.getItem(PAIRING_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredPairing(code: string): void {
  try {
    localStorage.setItem(PAIRING_STORAGE_KEY, code)
  } catch {
    // Private windows refuse storage; the link still works for this visit.
  }
}
