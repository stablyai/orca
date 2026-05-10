import { PairingOfferSchema, type PairingOffer } from './types'

// Why: this file mirrors src/shared/pairing.ts (which is covered by CI
// vitest) but uses atob/btoa because Metro/Hermes don't ship Node's
// Buffer. Keep the parsing semantics in sync — when one changes, update
// the other.

export function decodePairingUrl(url: string): PairingOffer | null {
  try {
    const hashIndex = url.indexOf('#')
    if (!url.startsWith('orca://pair') || hashIndex === -1) return null
    return decodePairingBase64(url.slice(hashIndex + 1))
  } catch {
    return null
  }
}

// Why: accept either an `orca://pair#<base64>` URL or the bare base64
// string so the paste-pair flow can take whichever the user actually
// copied from desktop.
export function parsePairingCode(input: string): PairingOffer | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  try {
    if (trimmed.startsWith('orca://pair')) {
      return decodePairingUrl(trimmed)
    }
    return decodePairingBase64(trimmed)
  } catch {
    return null
  }
}

function decodePairingBase64(base64url: string): PairingOffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const json = atob(base64)
  return PairingOfferSchema.parse(JSON.parse(json))
}
