import { describe, expect, it } from 'vitest'

import { compactMobileBrowserFileAddress, normalizeBrowserUrl } from './browser-url'

describe('normalizeBrowserUrl', () => {
  it('keeps localhost-style addresses as http URLs', () => {
    expect(normalizeBrowserUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeBrowserUrl('127.0.0.1:6769/web-index.html')).toBe(
      'http://127.0.0.1:6769/web-index.html'
    )
  })

  it('adds https for regular domains without a scheme', () => {
    expect(normalizeBrowserUrl('github.com/stablyai/orca')).toBe('https://github.com/stablyai/orca')
  })
})

describe('compactMobileBrowserFileAddress', () => {
  it('shows the decoded filename for local and Windows-style file URLs', () => {
    expect(compactMobileBrowserFileAddress('file:///Users/me/reports/status%20report.html')).toBe(
      'file: …/status report.html'
    )
    expect(compactMobileBrowserFileAddress('file:///C:/Users/me/report.htm')).toBe(
      'file: …/report.htm'
    )
  })

  it('does not compact ordinary or malformed URLs', () => {
    expect(compactMobileBrowserFileAddress('https://example.com/report.html')).toBeNull()
    expect(compactMobileBrowserFileAddress('not a url')).toBeNull()
  })
})
