import { describe, expect, it } from 'vitest'

import { isExternallyOpenablePdfUrl } from './mobile-browser-pdf-link'

describe('isExternallyOpenablePdfUrl', () => {
  it('accepts http(s) PDF URLs the phone can fetch itself', () => {
    expect(isExternallyOpenablePdfUrl('https://example.com/report.pdf')).toBe(true)
    expect(isExternallyOpenablePdfUrl('http://example.com/report.PDF?download=1#page=2')).toBe(true)
    expect(isExternallyOpenablePdfUrl('https://example.com/report%2Epdf')).toBe(true)
  })

  it('rejects non-PDF paths and non-http schemes', () => {
    expect(isExternallyOpenablePdfUrl('https://example.com/report.txt')).toBe(false)
    expect(isExternallyOpenablePdfUrl('https://example.com/report.pdf.txt')).toBe(false)
    expect(isExternallyOpenablePdfUrl('intent://example.com/report.pdf#Intent;end')).toBe(false)
    expect(isExternallyOpenablePdfUrl('file:///Users/me/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('not a url')).toBe(false)
  })

  it('rejects loopback URLs that cannot name the same document on the phone', () => {
    expect(isExternallyOpenablePdfUrl('http://localhost:3000/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://localhost./report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://app.localhost/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://127.0.0.1/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://127.1.2.3/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://[::1]/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://[::ffff:127.0.0.1]/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://[::ffff:7f00:1]/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://0x7f.1/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://0177.0.0.1/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://2130706433/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://%6cocalhost/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://localhost\\@example.com/report.pdf')).toBe(false)
    expect(isExternallyOpenablePdfUrl('http://example.com@localhost/report.pdf')).toBe(false)
  })
})
