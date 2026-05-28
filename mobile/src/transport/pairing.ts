import { PairingOfferSchema, type PairingOffer } from './types'

// Why: this file mirrors src/shared/pairing.ts (which is covered by CI
// vitest) but uses atob/btoa because Metro/Hermes don't ship Node's
// Buffer. Keep the parsing semantics in sync — when one changes, update
// the other.

export function decodePairingUrl(url: string): PairingOffer | null {
  try {
    const code = extractPairingCodeFromUrl(url)
    if (!code) return null
    return decodePairingBase64(code)
  } catch {
    return null
  }
}

// Why: system camera apps hand us the raw custom-scheme URL. Keeping
// extraction here makes QR scan, paste, and external deep-link flows
// accept the same URL shapes.
export function extractPairingCodeFromUrl(url: string): string | null {
  if (!url.startsWith('orca://pair')) return null
  const hashIndex = url.indexOf('#')
  if (hashIndex !== -1) {
    return url.slice(hashIndex + 1) || null
  }
  const queryIndex = url.indexOf('?')
  if (queryIndex !== -1) {
    const params = new URLSearchParams(url.slice(queryIndex + 1))
    return params.get('code')
  }
  return null
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
