import { describe, expect, it } from 'vitest'
import { splitForSpeech, toSpeechText } from './speech-text'

const placeholders = { code: 'Code skipped.', table: 'Table skipped.', link: 'link' }

describe('toSpeechText', () => {
  it('replaces code blocks and tables with short cues', () => {
    const markdown = [
      'Before.',
      '',
      '| Day | Run |',
      '|---|---|',
      '| Tue | Intervals |',
      '',
      '```ts',
      'const x = 1',
      '```',
      'After.'
    ].join('\n')
    expect(toSpeechText(markdown, placeholders)).toBe('Before. Table skipped. Code skipped. After.')
  })

  it('strips formatting, links and paths but keeps the words', () => {
    const markdown = [
      '## Summary ✅',
      '- Changed **plan** in `trening/plan-aktualny.md:42`',
      '- Tuesday → intervals',
      'See [zones](trening/strefy.md) or https://example.com/x'
    ].join('\n')
    expect(toSpeechText(markdown, placeholders)).toBe(
      'Summary. Changed plan in plan aktualny. Tuesday, intervals. See link zones or link.'
    )
  })

  describe('links', () => {
    const markdown = [
      'Sources:',
      '- [WHO report 2025](https://www.who.int/publications/i/item/9789240000000)',
      '- <https://example.com/study.pdf>',
      'Details in [the plan](docs/plan.md).'
    ].join('\n')
    const read = (mode: Parameters<typeof toSpeechText>[2]) =>
      toSpeechText(markdown, placeholders, mode)

    it('says "link" before the text, and only "link" for a bare address', () => {
      expect(read('word-and-text')).toBe(
        'Sources: link WHO report 2025. link. Details in link the plan.'
      )
    })

    it('can add the site, or read only the text', () => {
      expect(read('word-text-site')).toBe(
        'Sources: link WHO report 2025, who.int. link example.com. Details in link the plan.'
      )
      expect(read('text')).toBe('Sources: WHO report 2025. link. Details in the plan.')
    })

    it('can skip links altogether', () => {
      expect(read('off')).toBe('Sources: Details in.')
    })

    it('treats a link whose text is its address as a bare address', () => {
      const markdown = '[https://x.com/a](https://x.com/a)'
      expect(toSpeechText(markdown, placeholders, 'word-and-text')).toBe('link.')
    })
  })

  it('keeps inline code that is not a path', () => {
    expect(toSpeechText('Run `pnpm test` now', placeholders)).toBe('Run pnpm test now.')
  })
})

describe('splitForSpeech', () => {
  it('keeps short text whole', () => {
    expect(splitForSpeech('One. Two.', 100)).toEqual(['One. Two.'])
  })

  it('cuts long text at sentence ends within the limit', () => {
    const chunks = splitForSpeech('First sentence here. Second sentence here. Third one.', 30)
    expect(chunks).toEqual(['First sentence here.', 'Second sentence here.', 'Third one.'])
    expect(chunks.every((chunk) => chunk.length <= 30)).toBe(true)
  })
})
