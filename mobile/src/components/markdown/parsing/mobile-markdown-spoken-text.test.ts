import { describe, expect, it } from 'vitest'
import { mobileMarkdownSpokenText } from './mobile-markdown-spoken-text'

describe('mobileMarkdownSpokenText', () => {
  it('reads the words and skips code blocks', () => {
    const markdown = [
      '## Plan',
      '',
      'Run **the tests** with `pnpm test`, see [the docs](https://example.com/docs). Area $x^2$ grows.',
      '',
      '```ts',
      'const answer = 42',
      '```',
      '',
      '- first step',
      '- second step'
    ].join('\n')
    expect(mobileMarkdownSpokenText(markdown)).toBe(
      'Plan\nRun the tests with pnpm test, see the docs. Area grows.\nfirst step\nsecond step'
    )
  })
})
