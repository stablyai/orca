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

it('matches a live token-bearing Kagi address however the expected query spells a space', () => {
  const guard = new ExpectedPageUrlGuard('https://kagi.com/search?q=hello%20world', 'page')
  expect(() => guard.verify(['https://kagi.com/search?q=hello%20world&token=secret'])).not.toThrow()
  expect(() =>
    new ExpectedPageUrlGuard('https://kagi.com/search?q=hello%20world', 'page').verify([
      'https://kagi.com/search?q=other&token=secret'
    ])
  ).toThrow()
})

it('treats only the spellings of a space alike and fails closed on undecodable queries', () => {
  const live = (query: string): string[] => [`https://kagi.com/search?${query}&token=secret`]
  const verify = (expected: string, query: string): void =>
    new ExpectedPageUrlGuard(`https://kagi.com/search?${expected}`, 'page').verify(live(query))
  expect(() => verify('q=a+b', 'q=a%20b')).not.toThrow()
  // Form re-serialization would equate each pair; they are different requests.
  expect(() => verify('q=a%2Fb', 'q=a/b')).toThrow()
  expect(() => verify('q=%7E', 'q=~')).toThrow()
  expect(() => verify('q=', 'q')).toThrow()
  expect(() => verify('q=a%2Bb', 'q=a+b')).toThrow()
  expect(() => verify('q=%25zz', 'q=%zz')).toThrow()
  expect(() => verify('q=%zz', 'q=%zz')).toThrow()
})

it('accepts its own redacted receipt back as the expected URL', () => {
  const live = ['https://kagi.com/search?q=~a:b,c/d&token=secret']
  const discovery = new ExpectedPageUrlGuard(live[0], 'page')
  discovery.verify(live)
  const receipt: Record<string, unknown> = discovery.withReceipt({})
  const checkedUrl = String(receipt.checkedUrl)
  expect(checkedUrl).toBe('https://kagi.com/search?q=~a:b,c/d')
  expect(() => new ExpectedPageUrlGuard(checkedUrl, 'page').verify(live)).not.toThrow()
})
