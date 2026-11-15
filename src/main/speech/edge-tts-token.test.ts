import { describe, expect, it } from 'vitest'
import { edgeSecMsGec, edgeTtsWebSocketUrl } from './edge-tts-token'

describe('Edge speech token', () => {
  it('reproduces the token captured from Edge for the 2026-10-13 window', () => {
    expect(edgeSecMsGec(1791888000)).toBe(
      '492D7694A183A45E-56E821F95D4579C5B7C7E33DC7303FF379EC36D510213555BBBB9EB17EF15876'
    )
  })

  it('puts that token on the speech socket url', () => {
    const url = new URL(edgeTtsWebSocketUrl('abc', 1791888000))
    expect(url.host).toBe('speech.platform.bing.com')
    expect(url.searchParams.get('ConnectionId')).toBe('abc')
    expect(url.searchParams.get('Sec-MS-GEC-Version')).toBe('2-143.0.3650.75')
    expect(url.searchParams.get('Sec-MS-GEC')).toBe(edgeSecMsGec(1791888000))
  })
})
