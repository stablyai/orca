import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const paneSecretHashes = new Map<string, Buffer>()

export function mintJcodePaneSecret(paneKey: string): string {
  const secret = randomBytes(32).toString('hex')
  paneSecretHashes.delete(paneKey)
  paneSecretHashes.set(paneKey, createHash('sha256').update(secret).digest())
  if (paneSecretHashes.size > 1000) {
    const oldest = paneSecretHashes.keys().next().value
    if (oldest !== undefined) {
      paneSecretHashes.delete(oldest)
    }
  }
  return secret
}

export function verifyJcodePaneSecret(paneKey: string, secret: unknown): boolean {
  if (typeof secret !== 'string' || secret.length === 0) {
    return false
  }
  const expected = paneSecretHashes.get(paneKey)
  return Boolean(
    expected && timingSafeEqual(expected, createHash('sha256').update(secret).digest())
  )
}

export function forgetJcodePaneSecret(paneKey: string): void {
  paneSecretHashes.delete(paneKey)
}
