import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../shared/secret-store'
import { savedCredentialUnreadable } from './saved-credential-readability'

const PREFIX = 'orca-test-key:v1:'
const SEAL = 'sealed-here:'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-saved-credential-readability-'))
  path = join(dir, 'key.enc')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`${SEAL}${plainText}`),
    decryptString: (cipher) => {
      const text = cipher.toString()
      if (!text.startsWith(SEAL)) {
        throw new Error('not sealed by this store')
      }
      return text.slice(SEAL.length)
    },
    describeProtectionGap: () => null
  })
})

afterEach(() => {
  _resetSecretStoreForTests()
  rmSync(dir, { recursive: true, force: true })
})

function judge(contents: string): ReturnType<typeof savedCredentialUnreadable> {
  writeFileSync(path, contents)
  return savedCredentialUnreadable({ path, envelopePrefix: PREFIX })
}

function encrypted(cipher: Buffer): string {
  return `${PREFIX}encrypted:${cipher.toString('base64')}`
}

describe('savedCredentialUnreadable', () => {
  it('accepts a file this store sealed', () => {
    expect(judge(encrypted(Buffer.from(`${SEAL}key`)))).toBeUndefined()
  })

  it('reports a well-formed file another store sealed as sealed elsewhere', () => {
    expect(judge(encrypted(Buffer.from('other-app-cipher')))).toBe('sealed-elsewhere')
  })

  it.each([
    ['an empty', ''],
    ['a non-base64', 'not*base64!'],
    ['a truncated base64', 'c2VhbGVkLWhlcmU6a2V5x']
  ])('reports %s payload as unreadable, not sealed elsewhere', (_label, payload) => {
    expect(judge(`${PREFIX}encrypted:${payload}`)).toBe('unreadable')
  })
})
