import { PAIRING_OFFER_VERSION, PairingOfferSchema, type PairingOffer } from './types'

// Why: this file mirrors src/shared/pairing.ts (which is covered by CI
// vitest) but uses atob/btoa because Metro/Hermes don't ship Node's
// Buffer. Keep the parsing semantics in sync — when one changes, update
// the other. The rejection reasons below are mobile-only and add no
// accept/reject difference: they explain a refusal the shared copy states
// as null.

// Why: one "invalid code" message covered a wrong link, a truncated paste and
// an app too old to understand the offer. Users can't tell those apart, so the
// rejection names which one it was.
export type PairingRejection =
  | { reason: 'empty' }
  | { reason: 'not-pairing-link' }
  | { reason: 'missing-code' }
  | { reason: 'malformed-code' }
  | { reason: 'unsupported-version'; offerVersion: number; supportedVersion: number }
  | { reason: 'invalid-offer' }

export type PairingParseResult =
  | { ok: true; offer: PairingOffer }
  | { ok: false; rejection: PairingRejection }

export function decodePairingUrl(url: string): PairingOffer | null {
  const result = parsePairingUrl(url)
  return result.ok ? result.offer : null
}

// Why: QR and deep-link payloads must be the `orca://pair` route — a bare
// base64 blob is only trusted from a deliberate paste, not from anything the
// camera happens to see.
export function parsePairingUrl(url: string): PairingParseResult {
  const trimmed = url.trim()
  if (!trimmed) {
    return reject({ reason: 'empty' })
  }
  if (matchPairRouteRest(trimmed) === null) {
    return reject({ reason: 'not-pairing-link' })
  }
  const code = extractPairingCodeFromUrl(trimmed)
  if (!code) {
    return reject({ reason: 'missing-code' })
  }
  return parsePairingOfferCode(code)
}

// Why: system camera apps hand us the raw custom-scheme URL. Keeping
// extraction here makes QR scan, paste, and external deep-link flows
// accept the same URL shapes.
export function extractPairingCodeFromUrl(url: string): string | null {
  const rest = matchPairRouteRest(url)
  if (rest === null) {
    return null
  }

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

// Everything after `orca://pair`, or null when the input is not that route.
function matchPairRouteRest(url: string): string | null {
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
  return trimmed.slice(match[0].length)
}

// Why: accept either an `orca://pair?...` URL or the bare base64
// string so the paste-pair flow can take whichever the user actually
// copied from desktop.
export function parsePairingCode(input: string): PairingOffer | null {
  const result = parsePairingInput(input)
  return result.ok ? result.offer : null
}

export function parsePairingInput(input: string): PairingParseResult {
  const trimmed = input.trim()
  if (!trimmed) {
    return reject({ reason: 'empty' })
  }
  if (/^orca:\/\//i.test(trimmed)) {
    return parsePairingUrl(trimmed)
  }
  return parsePairingOfferCode(trimmed)
}

function parsePairingOfferCode(code: string): PairingParseResult {
  let payload: unknown
  try {
    payload = JSON.parse(decodePairingBase64(code))
  } catch {
    return reject({ reason: 'malformed-code' })
  }

  // Why: the offer version is readable before schema validation, so an app too
  // old for this desktop says so instead of blaming the pasted text.
  const offerVersion = readOfferVersion(payload)
  if (offerVersion !== null && offerVersion !== PAIRING_OFFER_VERSION) {
    return reject({
      reason: 'unsupported-version',
      offerVersion,
      supportedVersion: PAIRING_OFFER_VERSION
    })
  }

  const parsed = PairingOfferSchema.safeParse(payload)
  if (!parsed.success) {
    return reject({ reason: 'invalid-offer' })
  }
  return { ok: true, offer: parsed.data }
}

function readOfferVersion(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const version = (payload as { v?: unknown }).v
  return typeof version === 'number' && Number.isFinite(version) ? version : null
}

function reject(rejection: PairingRejection): PairingParseResult {
  return { ok: false, rejection }
}

function decodePairingBase64(base64url: string): string {
  // Why: desktop intentionally strips base64 padding from QR payloads. Some
  // mobile JS runtimes reject unpadded atob input, so restore it before decode.
  const base64 = padBase64(base64url.replace(/-/g, '+').replace(/_/g, '/'))
  return atob(base64)
}

function padBase64(base64: string): string {
  const remainder = base64.length % 4
  if (remainder === 0) {
    return base64
  }
  return `${base64}${'='.repeat(4 - remainder)}`
}
