import { describe, expect, it, vi } from 'vitest'
import {
  classifyClaudeCredentialsBlob,
  readComposedClaudeCredentials
} from './claude-credential-read-result'

const CREDENTIALS = '{"claudeAiOauth":{"accessToken":"scoped"}}'
const FILE_CREDENTIALS = '{"claudeAiOauth":{"accessToken":"file"}}'

/** `isTransientKeychainError` classifies by message, so these are the real shapes it sees. */
const LOCKED = new Error('The specified keychain could not be found. Keychain is locked')
const DURABLE = new Error('SecKeychainSearchCopyNext: The specified item could not be found')

describe('classifyClaudeCredentialsBlob', () => {
  it('treats an empty or missing blob as absent', () => {
    expect(classifyClaudeCredentialsBlob(null)).toEqual({ kind: 'absent' })
    expect(classifyClaudeCredentialsBlob('   ')).toEqual({ kind: 'absent' })
  })

  it('treats a non-empty unparseable blob as unavailable, not absent', () => {
    // Ablation: returning `absent` here makes a torn read look like a signed-out account, and the
    // caller then reports "No credentials" for an account that has one.
    expect(classifyClaudeCredentialsBlob('{"claudeAiOauth"')).toEqual({
      kind: 'unavailable',
      reason: 'malformed'
    })
    expect(classifyClaudeCredentialsBlob('[]')).toEqual({
      kind: 'unavailable',
      reason: 'malformed'
    })
  })
})

describe('readComposedClaudeCredentials', () => {
  it('returns the scoped Keychain value without reading the file', async () => {
    const readSameHomeFile = vi.fn(() => FILE_CREDENTIALS)
    const result = await readComposedClaudeCredentials({
      readScopedKeychain: async () => CREDENTIALS,
      readSameHomeFile
    })
    expect(result).toEqual({ kind: 'present', credentialsJson: CREDENTIALS })
    expect(readSameHomeFile).not.toHaveBeenCalled()
  })

  it('does NOT consult the file when the Keychain fails transiently', async () => {
    // Ablation: dropping the `isTransientKeychainError` branch in readComposedClaudeCredentials
    // makes this return the file's token. That file is a durable-outage fallback which can hold an
    // already-rotated credential, so serving it because the Keychain was momentarily locked
    // replays a spent refresh token and the server revokes the whole family.
    const readSameHomeFile = vi.fn(() => FILE_CREDENTIALS)
    const result = await readComposedClaudeCredentials({
      readScopedKeychain: async () => {
        throw LOCKED
      },
      readSameHomeFile
    })
    expect(result).toEqual({ kind: 'unavailable', reason: 'keychain-transient' })
    expect(readSameHomeFile).not.toHaveBeenCalled()
  })

  it('falls back to the file on a durable Keychain failure', async () => {
    const result = await readComposedClaudeCredentials({
      readScopedKeychain: async () => {
        throw DURABLE
      },
      readSameHomeFile: () => FILE_CREDENTIALS
    })
    expect(result).toEqual({ kind: 'present', credentialsJson: FILE_CREDENTIALS })
  })

  it('falls back to the file when the scoped item is simply absent', async () => {
    const result = await readComposedClaudeCredentials({
      readScopedKeychain: async () => null,
      readSameHomeFile: () => FILE_CREDENTIALS
    })
    expect(result).toEqual({ kind: 'present', credentialsJson: FILE_CREDENTIALS })
  })

  it('refuses the file while a stale-fallback marker is set', async () => {
    // Ablation: removing the hasStaleFallbackMarker check serves a token we already replaced in
    // the Keychain but failed to clear from disk.
    const readSameHomeFile = vi.fn(() => FILE_CREDENTIALS)
    const result = await readComposedClaudeCredentials({
      readScopedKeychain: async () => null,
      hasStaleFallbackMarker: () => true,
      readSameHomeFile
    })
    expect(result).toEqual({ kind: 'unavailable', reason: 'stale-fallback-present' })
    expect(readSameHomeFile).not.toHaveBeenCalled()
  })

  it('reports a torn scoped item as unavailable rather than falling through to the file', async () => {
    const readSameHomeFile = vi.fn(() => FILE_CREDENTIALS)
    const result = await readComposedClaudeCredentials({
      readScopedKeychain: async () => '{"claudeAiOauth"',
      readSameHomeFile
    })
    expect(result).toEqual({ kind: 'unavailable', reason: 'malformed' })
    expect(readSameHomeFile).not.toHaveBeenCalled()
  })

  it('is absent only when both media are absent', async () => {
    const result = await readComposedClaudeCredentials({
      readScopedKeychain: async () => null,
      readSameHomeFile: () => null
    })
    expect(result).toEqual({ kind: 'absent' })
  })
})
