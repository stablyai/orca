/**
 * Issue #8943 — "Browser shows insecure" (screenshot-only report).
 *
 * Attempted code-level mapping:
 * - Main BrowserAddressBar has no secure/insecure chrome (Globe/Search only).
 * - Popup origin bar *does* show "Not secure" for plain http:// remote hosts
 *   via describePopupOrigin — intentional Chromium-like UX, not a false positive
 *   for https://.
 * - Guest webPreferences set allowRunningInsecureContent: false (blocks mixed
 *   content; can surface as security errors on http assets under https).
 *
 * Without analyzing the user attachment (security policy: no user-uploaded
 * binaries/images as evidence input), there is no concrete false-positive path
 * for legitimate https:// navigations in this tree. Labeled cannot_repro
 * for a product defect; document intentional "Not secure" for remote http.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/browser/repro-8943-browser-insecure-indicator.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describePopupOrigin } from './popup-origin-bar-window'

const addressBarSource = readFileSync(
  join(__dirname, '../../renderer/src/components/browser-pane/BrowserAddressBar.tsx'),
  'utf8'
)
const browserManagerSource = readFileSync(join(__dirname, 'browser-manager.ts'), 'utf8')

describe('#8943 browser "insecure" indicator (screenshot-only)', () => {
  it('main address bar has no Not-secure / lock security chrome', () => {
    expect(addressBarSource).not.toMatch(/Not secure|insecure|isSecure/)
    // Only Globe/Search icons for chrome affordances.
    expect(addressBarSource).toMatch(/Globe|Search/)
  })

  it('popup origin bar flags only non-loopback http as insecure (intentional)', () => {
    expect(describePopupOrigin('https://example.com/login')).toEqual({
      label: 'https://example.com',
      insecure: false
    })
    expect(describePopupOrigin('http://phish.example.net/login').insecure).toBe(true)
    expect(describePopupOrigin('http://localhost:3000/').insecure).toBe(false)
    expect(describePopupOrigin('about:blank').insecure).toBe(false)
  })

  it('guest browser disallows running insecure mixed content', () => {
    expect(browserManagerSource).toMatch(/allowRunningInsecureContent:\s*false/)
  })
})
