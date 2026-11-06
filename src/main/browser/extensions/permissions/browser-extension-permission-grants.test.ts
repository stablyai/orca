import { describe, expect, it } from 'vitest'
import { originPatternCovers } from './browser-extension-permission-grants'

describe('originPatternCovers', () => {
  it.each([
    ['<all_urls>', 'https://a.test/*', true],
    ['*://*/*', 'https://a.test/x', true],
    ['https://*.a.test/*', 'https://b.a.test/*', true],
    ['https://*.a.test/*', 'https://a.test/*', true],
    ['https://a.test/*', 'https://*.a.test/*', false],
    ['https://a.test/x/*', 'https://a.test/y', false],
    ['http://*/*', 'https://a.test/*', false],
    ['https://a.test/*', '<all_urls>', false]
  ])('%s covers %s: %s', (granted, requested, expected) => {
    expect(originPatternCovers(granted, requested)).toBe(expected)
  })
})
