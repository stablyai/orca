import { expect, it } from 'vitest'
import { heldSwitchScreenFits } from './terminal-switch-close-capture'

// The held screen rides every stream once and each list call: its bound is the bytes JSON carries,
// where each control byte escapes to six.
it.each([
  { screen: 'a'.repeat(256 * 1024 - 8), fits: true },
  { screen: 'a'.repeat(256 * 1024), fits: false },
  { screen: '\x1b'.repeat(43_000), fits: true },
  { screen: '\x1b'.repeat(44_000), fits: false }
])('bounds a held screen of $screen.length characters to 256 KiB on the wire', (c) => {
  expect(heldSwitchScreenFits(c.screen)).toBe(c.fits)
  expect(heldSwitchScreenFits('', c.screen)).toBe(c.fits)
})
