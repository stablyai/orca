// tests/normalize.wiztokens.test.js
import { test, expect } from 'vitest'
import { parseWizTokens } from '../lib/normalize.js'

test('parseWizTokens extracts boq tokens from page HTML', () => {
  const html =
    '<script nonce="x">window.WIZ_global_data = {"cfb2h":"boq_assistant-bard-web-server_20260630.21_p0","SNlM0e":"AD1_LWtok","FdrFJe":"-4793405012578916395"};</script>'
  expect(parseWizTokens(html)).toEqual({
    at: 'AD1_LWtok',
    bl: 'boq_assistant-bard-web-server_20260630.21_p0',
    fsid: '-4793405012578916395'
  })
})

test('parseWizTokens returns nulls when tokens absent', () => {
  expect(parseWizTokens('<html>no tokens here</html>')).toEqual({ at: null, bl: null, fsid: null })
  expect(parseWizTokens('')).toEqual({ at: null, bl: null, fsid: null })
})
