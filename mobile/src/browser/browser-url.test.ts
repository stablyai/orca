import { describe, expect, it } from 'vitest'

import { normalizeBrowserUrl } from './browser-url'

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
