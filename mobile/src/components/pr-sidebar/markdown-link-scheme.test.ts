import { describe, expect, it } from 'vitest'
import { isAllowedMarkdownLinkUrl } from './markdown-link-scheme'

describe('isAllowedMarkdownLinkUrl', () => {
  it('allows http, https, and mailto', () => {
    expect(isAllowedMarkdownLinkUrl('https://github.com/o/r')).toBe(true)
    expect(isAllowedMarkdownLinkUrl('http://example.com')).toBe(true)
    expect(isAllowedMarkdownLinkUrl('mailto:dev@example.com')).toBe(true)
  })

  it('rejects unsafe and unparseable schemes', () => {
    expect(isAllowedMarkdownLinkUrl('javascript:alert(1)')).toBe(false)
    expect(isAllowedMarkdownLinkUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedMarkdownLinkUrl('app://deep/link')).toBe(false)
    expect(isAllowedMarkdownLinkUrl('not a url')).toBe(false)
    expect(isAllowedMarkdownLinkUrl('')).toBe(false)
  })
})
