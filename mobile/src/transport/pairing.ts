import { PairingOfferSchema, type PairingOffer } from './types'

interface PairingLinkSource {
  getLinkingURL(): string | null
  getInitialURL(): Promise<string | null>
}

// Why: this file mirrors src/shared/pairing.ts (which is covered by CI
// vitest) but uses atob/btoa because Metro/Hermes don't ship Node's
// Buffer. Keep the parsing semantics in sync — when one changes, update
// the other.

export function decodePairingUrl(url: string): PairingOffer | null {
  try {
    const code = extractPairingCodeFromUrl(url)
    if (!code) {
      return null
    }
    return decodePairingBase64(code)
  } catch {
    return null
  }
}

// Why: system camera apps hand us the raw custom-scheme URL. Keeping
// extraction here makes QR scan, paste, and external deep-link flows
// accept the same URL shapes.
export function extractPairingCodeFromUrl(url: string): string | null {
  const trimmed = url.trim()
  const match = /^orca:\/\/([^/?#]*)([^?#]*)?/i.exec(trimmed)
  if (!match) {
    return null
  }
  const host = match[1]?.toLowerCase()
  const pathname = match[2] ?? ''
  if (host !== 'pair' || (pathname !== '' && pathname !== '/')) {
    return null
  }

  const rest = trimmed.slice(match[0].length)
  const queryIndex = rest.indexOf('?')
  if (queryIndex !== -1) {
    const query = rest.slice(queryIndex + 1).split('#')[0] ?? ''
    const params = new URLSearchParams(query)
    const code = params.get('code')
    if (code) {
      return code
    }
  }
  const hashIndex = rest.indexOf('#')
  if (hashIndex !== -1) {
    return rest.slice(hashIndex + 1) || null
  }
  return null
}

// Scene launches populate Expo's native registry instead of React Native's
// legacy launch options; Android still relies on the asynchronous fallback.
export async function getInitialPairingCode(source: PairingLinkSource): Promise<string | null> {
  // Why: scene-based Linking can throw on some iOS cold starts; match getInitialURL
  // and treat any failure as "no launch URL" so pair deep-links never reject the shell.
  let linkingUrl: string | null = null
  try {
    linkingUrl = source.getLinkingURL()
  } catch {
    linkingUrl = null
  }
  const url = linkingUrl ?? (await source.getInitialURL().catch(() => null))
  return url ? extractPairingCodeFromUrl(url) : null
}

// Why: accept either an `orca://pair?...` URL or the bare base64
// string so the paste-pair flow can take whichever the user actually
// copied from desktop.
export function parsePairingCode(input: string): PairingOffer | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  try {
    if (/^orca:\/\//i.test(trimmed)) {
      return decodePairingUrl(trimmed)
    }
    return decodePairingBase64(trimmed)
  } catch {
    return null
  }
}

function decodePairingBase64(base64url: string): PairingOffer {
  // Why: desktop intentionally strips base64 padding from QR payloads. Some
  // mobile JS runtimes reject unpadded atob input, so restore it before decode.
  const base64 = padBase64(base64url.replace(/-/g, '+').replace(/_/g, '/'))
  const json = atob(base64)
  return PairingOfferSchema.parse(JSON.parse(json))
}

function padBase64(base64: string): string {
  const remainder = base64.length % 4
  if (remainder === 0) {
    return base64
  }
  return `${base64}${'='.repeat(4 - remainder)}`
}
