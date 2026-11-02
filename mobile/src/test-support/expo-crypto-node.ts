import { randomBytes, randomUUID } from 'node:crypto'

/**
 * `expo-crypto` for vitest, aliased in `vitest.config.ts`: the native module has no Node build, and
 * shared code reaches it through `randomV4Uuid`'s fallback. Node's secure source behind the same
 * names; a test file's own mock of `expo-crypto` still wins.
 */
export function getRandomBytes(byteCount: number): Uint8Array {
  return new Uint8Array(randomBytes(byteCount))
}

export { randomUUID }
