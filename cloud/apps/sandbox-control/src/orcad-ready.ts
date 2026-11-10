// The pairing offer is a bearer credential for the VM's orcad. Vercel keeps a command's stdout as
// retrievable logs (GET .../cmd/:id/logs, found live), but not its env and not files read back, so
// orca-sandbox-start prints only where the offer is and the control plane reads it with the files
// API. Images that predate this still print the offer itself; both shapes are accepted.
// Given a per-call key in env, current images also seal the offer into that pointer line (AES-256-CTR:
// the logs only ever hold ciphertext), so the wake path skips the files API round trip. A pointer
// that is unsealed, or that does not open with the key, is still read from the file.
import type { SandboxProviderApi } from './sandbox-provider'

/** Asks orca-sandbox-start to print a pointer line instead of the offer. */
export const READY_VIA_FILE_ENV = { ORCA_READY_VIA: 'file' } as const

const READY_FILE = /^\/(?:[A-Za-z0-9._-]+\/)*ready\.json$/
const SEALED_OFFER = /^([0-9a-f]{32})\.([A-Za-z0-9+/]+={0,2})$/

/** A fresh key for one start command; it rides only in that command's env. */
export function createReadyKey(): { key: Uint8Array; env: { ORCA_READY_KEY: string } } {
  const key = crypto.getRandomValues(new Uint8Array(32))
  return { key, env: { ORCA_READY_KEY: [...key].map((byte) => byte.toString(16).padStart(2, '0')).join('') } }
}

/** The offer object from the start command's last stdout line, reading it from the VM when pointed to. */
export async function resolveOrcadReadyLine(
  provider: Pick<SandboxProviderApi, 'readFile'>,
  sessionId: string,
  lastLine: string,
  readyKey?: Uint8Array
): Promise<unknown> {
  const line: unknown = JSON.parse(lastLine)
  if (!isPointer(line)) {
    return line
  }
  if (readyKey && typeof line.sealedOffer === 'string') {
    const offer = await unsealOffer(line.sealedOffer, readyKey).catch(() => null)
    if (offer) {
      return offer
    }
  }
  if (!READY_FILE.test(line.readyFile) || line.readyFile.split('/').includes('..')) {
    throw new Error('orcad ready pointer names an unexpected path')
  }
  const content = await provider.readFile(sessionId, line.readyFile)
  const offer = content?.trim().split('\n').at(-1)
  if (!offer) {
    throw new Error('orcad ready file is empty')
  }
  return JSON.parse(offer)
}

/** Null unless it opens to an offer-shaped object: CTR has no tag, so a wrong key yields noise. */
async function unsealOffer(sealed: string, readyKey: Uint8Array): Promise<object | null> {
  const match = SEALED_OFFER.exec(sealed)
  if (!match) {
    return null
  }
  const counter = Uint8Array.from(match[1]!.match(/../g)!, (pair) => Number.parseInt(pair, 16))
  const data = Uint8Array.from(atob(match[2]!), (char) => char.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', readyKey, { name: 'AES-CTR' }, false, ['decrypt'])
  // OpenSSL's aes-256-ctr counts over the whole 128-bit block.
  const plain = await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 128 }, key, data)
  const offer: unknown = JSON.parse(new TextDecoder().decode(plain).trim())
  return typeof offer === 'object' && offer !== null && typeof (offer as { pairingCode?: unknown }).pairingCode === 'string'
    ? offer
    : null
}

function isPointer(value: unknown): value is { readyFile: string; sealedOffer?: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readyFile?: unknown }).readyFile === 'string'
  )
}
