import { describe, expect, it } from 'vitest'
import {
  decodeProjectTableHeaderPath,
  getProjectTrustComparisonKey,
  normalizeProjectTrustKey
} from './codex-project-trust-key'

describe('decodeProjectTableHeaderPath', () => {
  it('decodes a basic (double-quote) header, unescaping backslashes', () => {
    expect(decodeProjectTableHeaderPath('[projects."d:\\\\tools\\\\repo"]')).toBe('d:\\tools\\repo')
  })

  it('decodes a literal (single-quote) header verbatim', () => {
    expect(decodeProjectTableHeaderPath("[projects.'d:\\tools\\repo']")).toBe('d:\\tools\\repo')
  })

  it('tolerates inline whitespace and a trailing comment', () => {
    expect(decodeProjectTableHeaderPath('[ projects . "/repo" ]  # note')).toBe('/repo')
  })

  it('returns null for non-project headers', () => {
    expect(decodeProjectTableHeaderPath('[hooks.state."k"]')).toBeNull()
    expect(decodeProjectTableHeaderPath('model = "x"')).toBeNull()
  })
})

describe('normalizeProjectTrustKey', () => {
  it('folds Windows separator and drive-letter case', () => {
    expect(normalizeProjectTrustKey('C:/Users/NW/Repo')).toBe('c:\\users\\nw\\repo')
    expect(normalizeProjectTrustKey('C:\\Users\\NW\\Repo')).toBe('c:\\users\\nw\\repo')
  })

  it('leaves POSIX paths case-sensitive', () => {
    expect(normalizeProjectTrustKey('/mnt/e/A')).toBe('/mnt/e/A')
  })
})

describe('getProjectTrustComparisonKey', () => {
  it('makes basic and literal Windows headers compare equal', () => {
    expect(getProjectTrustComparisonKey('[projects."d:\\\\tools\\\\repo"]')).toBe(
      getProjectTrustComparisonKey("[projects.'d:\\tools\\repo']")
    )
  })
})
