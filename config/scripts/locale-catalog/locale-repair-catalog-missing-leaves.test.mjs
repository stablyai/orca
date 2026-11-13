import { describe, expect, it } from 'vitest'

import { repairCatalog } from './locale-translation-policy.mjs'

// English keys can precede locale bootstrapping; missing leaves must not crash the entire repair.
describe('repairCatalog with un-bootstrapped keys', () => {
  const enCatalog = {
    auto: {
      lib: { agent: { catalog: { '760bc6883d': 'Codex' } } },
      components: { untranslated: 'Continue', nested: { alsoMissing: 'Refresh' } }
    }
  }

  const translatedOnly = () => ({ auto: { lib: { agent: { catalog: { '760bc6883d': '사본' } } } } })

  it('skips leaves the locale catalog is missing instead of throwing', () => {
    const localeCatalog = translatedOnly()
    expect(() => repairCatalog(enCatalog, localeCatalog, 'ko')).not.toThrow()
    expect(localeCatalog.auto.components).toBeUndefined()
  })
})
