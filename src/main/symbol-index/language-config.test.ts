import { describe, expect, it } from 'vitest'
import { getLanguageConfig, SUPPORTED_LANGUAGE_IDS } from './language-config'

describe('language-config', () => {
  it('returns a config with a non-empty query for supported languages', () => {
    for (const id of SUPPORTED_LANGUAGE_IDS) {
      const cfg = getLanguageConfig(id)
      expect(cfg, id).not.toBeNull()
      expect(cfg!.query.length).toBeGreaterThan(0)
      expect(cfg!.grammarKey.length).toBeGreaterThan(0)
    }
  })

  it('returns null for unsupported languages', () => {
    expect(getLanguageConfig('plaintext')).toBeNull()
    expect(getLanguageConfig('markdown')).toBeNull()
  })
})
