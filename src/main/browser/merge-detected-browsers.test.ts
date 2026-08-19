import { describe, expect, it } from 'vitest'
import { mergeDetectedBrowsers, type DetectedBrowserLike } from './merge-detected-browsers'

function browser(
  family: string,
  label: string,
  dataDir: string
): DetectedBrowserLike {
  return { family, label, dataDir }
}

describe('mergeDetectedBrowsers', () => {
  it('lets hardcoded win over discovered for the same dataDir', () => {
    const hardcoded = [browser('comet', 'Comet', '/Users/test/Library/Application Support/Comet')]
    const discovered = [browser('discovered-comet', 'Comet (discovered)', '/Users/test/Library/Application Support/Comet')]

    const merged = mergeDetectedBrowsers(hardcoded, [], discovered)

    expect(merged).toHaveLength(1)
    expect(merged[0].family).toBe('comet')
    expect(merged[0].label).toBe('Comet')
  })

  it('lets persistedCustom win over discovered for the same dataDir', () => {
    const persistedCustom = [browser('custom', 'My Browser', '/Users/test/Library/Application Support/Aside')]
    const discovered = [browser('discovered-aside', 'Aside', '/Users/test/Library/Application Support/Aside')]

    const merged = mergeDetectedBrowsers([], persistedCustom, discovered)

    expect(merged).toHaveLength(1)
    expect(merged[0].family).toBe('custom')
    expect(merged[0].label).toBe('My Browser')
  })

  it('lets hardcoded win over both persistedCustom and discovered for the same dataDir', () => {
    const dataDir = '/Users/test/Library/Application Support/Comet'
    const hardcoded = [browser('comet', 'Comet', dataDir)]
    const persistedCustom = [browser('custom', 'Custom Comet', dataDir)]
    const discovered = [browser('discovered', 'Discovered Comet', dataDir)]

    const merged = mergeDetectedBrowsers(hardcoded, persistedCustom, discovered)

    expect(merged).toHaveLength(1)
    expect(merged[0].family).toBe('comet')
    expect(merged[0].label).toBe('Comet')
  })

  it('treats trailing-slash and case-different dataDirs as the same browser', () => {
    const hardcoded = [browser('comet', 'Comet', '/Users/test/Library/Application Support/Comet')]
    const discovered = [browser('dup', 'Dup', '/users/test/library/application support/comet/')]

    const merged = mergeDetectedBrowsers(hardcoded, [], discovered)

    expect(merged).toHaveLength(1)
    expect(merged[0].family).toBe('comet')
  })

  it('keeps two genuinely different dataDirs', () => {
    const hardcoded = [browser('comet', 'Comet', '/Users/test/Library/Application Support/Comet')]
    const discovered = [browser('aside', 'Aside', '/Users/test/Library/Application Support/Aside')]

    const merged = mergeDetectedBrowsers(hardcoded, [], discovered)

    expect(merged).toHaveLength(2)
    expect(merged.map((b) => b.family).sort()).toEqual(['aside', 'comet'])
  })

  it('dedups by data root only, not per profile', () => {
    // Both entries share the same browser root; a per-profile dedup would keep both.
    const dataDir = '/Users/test/Library/Application Support/Comet'
    const hardcoded = [browser('comet', 'Comet', dataDir)]
    const discovered = [browser('dup', 'Dup', dataDir)]

    const merged = mergeDetectedBrowsers(hardcoded, [], discovered)

    expect(merged).toHaveLength(1)
  })

  it('accepts an injected canonicalize seam for symlink/realpath resolution', () => {
    // Two distinct spellings that a realpath canonicalizer collapses to one root.
    const canonicalize = (dataDir: string): string =>
      dataDir.includes('Comet') ? '/real/Comet' : dataDir
    const hardcoded = [browser('comet', 'Comet', '/Users/test/Library/Application Support/Comet')]
    const discovered = [browser('dup', 'Dup', '/symlink/to/Comet')]

    const merged = mergeDetectedBrowsers(hardcoded, [], discovered, { canonicalize })

    expect(merged).toHaveLength(1)
    expect(merged[0].family).toBe('comet')
  })
})
