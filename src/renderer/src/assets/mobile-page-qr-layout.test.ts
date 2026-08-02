import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const mobilePageCss = fs.readFileSync(new URL('./mobile-page.css', import.meta.url), 'utf8')

describe('mobile page QR grid layout (#9700)', () => {
  it('defines a shared large-QR size token used by the box and grid tracks', () => {
    expect(mobilePageCss).toMatch(/--mp-qr-large-size:\s*184px/)
    expect(mobilePageCss).toMatch(
      /\.mobile-page-root \.mp-qr-large\s*{[^}]*width:\s*var\(--mp-qr-large-size\)/s
    )
  })

  // Why: `auto` sized the QR track to the unwrapped relay-degraded notice and
  // starved the copy column so CJK wrapped one glyph per line (#9700).
  it('pins step and pairing QR columns to the QR size instead of auto', () => {
    expect(mobilePageCss).toMatch(
      /\.mobile-page-root \.mp-step2-layout\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--mp-qr-large-size\)/s
    )
    expect(mobilePageCss).toMatch(
      /\.mobile-page-root \.mp-pairing-layout\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+var\(--mp-qr-large-size\)/s
    )
    expect(mobilePageCss).not.toMatch(
      /\.mobile-page-root \.mp-(?:step2|pairing)-layout\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s
    )
  })

  it('lets under-QR stack children shrink so long notices wrap inside the track', () => {
    expect(mobilePageCss).toMatch(
      /\.mobile-page-root \.mp-qr-stack\s*>\s*\*\s*{[^}]*max-width:\s*100%[^}]*min-width:\s*0/s
    )
  })
})
