import { describe, expect, it } from 'vitest'
import {
  generateKeyPair,
  deriveSharedKey,
  decrypt
} from '../../../../../shared/remote-runtime/e2ee/node/e2ee-crypto'

describe('e2ee-crypto', () => {
  it('decrypt returns null for truncated data', () => {
    const shared = deriveSharedKey(generateKeyPair().secretKey, generateKeyPair().publicKey)
    expect(decrypt('dG9vc2hvcnQ=', shared)).toBeNull()
  })
})
