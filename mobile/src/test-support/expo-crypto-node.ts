import { randomBytes, randomUUID } from 'node:crypto'

// Alias the native-only crypto module to Node’s secure source for Vitest; explicit per-test mocks still win.
export function getRandomBytes(byteCount: number): Uint8Array {
  return new Uint8Array(randomBytes(byteCount))
}

export { randomUUID }
