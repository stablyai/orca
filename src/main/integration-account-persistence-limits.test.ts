import { describe, expect, it } from 'vitest'
import {
  assertIntegrationAccountCount,
  assertIntegrationCredentialBytes,
  assertIntegrationStringBytes,
  MAX_INTEGRATION_ACCOUNT_FILE_BYTES,
  MAX_INTEGRATION_ACCOUNTS,
  MAX_INTEGRATION_CREDENTIAL_BYTES,
  serializeIntegrationAccountFile
} from './integration-account-persistence-limits'

describe('integration account persistence limits', () => {
  it('admits the exact account boundary and rejects one more', () => {
    expect(() => assertIntegrationAccountCount('Test', MAX_INTEGRATION_ACCOUNTS)).not.toThrow()
    expect(() => assertIntegrationAccountCount('Test', MAX_INTEGRATION_ACCOUNTS + 1)).toThrow(
      `at most ${MAX_INTEGRATION_ACCOUNTS}`
    )
  })

  it('measures credential and metadata fields as UTF-8 bytes', () => {
    const exactCredential = 'é'.repeat(MAX_INTEGRATION_CREDENTIAL_BYTES / 2)
    expect(() => assertIntegrationCredentialBytes('Test', exactCredential)).not.toThrow()
    expect(() => assertIntegrationCredentialBytes('Test', `${exactCredential}a`)).toThrow(
      `${MAX_INTEGRATION_CREDENTIAL_BYTES} UTF-8 bytes`
    )

    expect(() => assertIntegrationStringBytes('Test', 'field', 'éé', 4)).not.toThrow()
    expect(() => assertIntegrationStringBytes('Test', 'field', 'ééa', 4)).toThrow('4 UTF-8 bytes')
  })

  it('serializes ordinary JSON identically through the bounded writer', () => {
    const value = { version: 1, accounts: [{ id: 'alpha', name: 'Ada' }] }
    expect(serializeIntegrationAccountFile(value)).toBe(JSON.stringify(value, null, 2))
  })

  it('admits an exact-size metadata file and rejects one extra byte', () => {
    const base = JSON.stringify({ value: '' }, null, 2)
    const exact = { value: 'a'.repeat(MAX_INTEGRATION_ACCOUNT_FILE_BYTES - base.length) }
    expect(Buffer.byteLength(JSON.stringify(exact, null, 2))).toBe(
      MAX_INTEGRATION_ACCOUNT_FILE_BYTES
    )
    expect(serializeIntegrationAccountFile(exact)).toBe(JSON.stringify(exact, null, 2))
    expect(() => serializeIntegrationAccountFile({ value: `${exact.value}a` })).toThrow(
      `${MAX_INTEGRATION_ACCOUNT_FILE_BYTES} bytes`
    )
  })
})
