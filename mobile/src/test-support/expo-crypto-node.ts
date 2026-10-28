import { createHash, randomBytes, randomUUID } from 'node:crypto'

// Alias the native-only crypto module to Node’s secure source for Vitest; explicit per-test mocks still win.
export function getRandomBytes(byteCount: number): Uint8Array {
  return new Uint8Array(randomBytes(byteCount))
}

export { randomUUID }

export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' } as const

export async function digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> {
  if (algorithm !== CryptoDigestAlgorithm.SHA256) {
    throw new Error(`the Node stand-in digests only SHA-256, not ${algorithm}`)
  }
  return new Uint8Array(createHash('sha256').update(data).digest()).buffer
}
