import { describe, expect, it } from 'vitest'
import { validateUploadUrl } from './diagnostic-bundle-upload'

describe('validateUploadUrl', () => {
  it('rejects http upload_url when tokenEndpoint is https (mixed scheme)', () => {
    expect(() =>
      validateUploadUrl('http://api.example.com/upload', 'https://api.example.com/token')
    ).toThrow(/must use https/)
  })

  it('rejects a mismatched host even when both are https (same-origin pin)', () => {
    expect(() =>
      validateUploadUrl('https://attacker.example.com/upload', 'https://api.example.com/token')
    ).toThrow(/must match tokenEndpoint host/)
  })
})
