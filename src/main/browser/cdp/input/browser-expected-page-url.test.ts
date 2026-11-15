import { expect, it } from 'vitest'
import { ExpectedPageUrlGuard } from './browser-expected-page-url'

it('accepts safe discovery, returns a safe receipt, and rejects a private-document change before an action step', () => {
  const guard = new ExpectedPageUrlGuard('https://kagi.com/search?q=one', 'page')
  guard.verify(['https://kagi.com/search?token=first&q=one'])
  expect(guard.withReceipt({ clicked: true })).toEqual({
    clicked: true,
    browserPageId: 'page',
    checkedUrl: 'https://kagi.com/search?q=one'
  })
  expect(() => guard.verifyStep(['https://kagi.com/search?token=second&q=one'])).toThrow()
  try {
    guard.verifyStep(['https://kagi.com/search?token=second&q=one'])
  } catch (error) {
    expect(JSON.stringify(error)).not.toContain('second')
    expect(String(error)).not.toContain('second')
  }
  const explicit = new ExpectedPageUrlGuard('https://kagi.com/search?token=first&q=one', 'page')
  expect(() => explicit.verify(['https://kagi.com/search?token=second&q=one'])).toThrow()
  expect(() =>
    new ExpectedPageUrlGuard('https://kagi.com/search?q=one', 'page').verify([
      'https://kagi.com/search?token=first&q=one',
      'https://kagi.com/search?token=second&q=one'
    ])
  ).toThrow()
})
