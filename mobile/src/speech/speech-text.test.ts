import { describe, expect, it } from 'vitest'
import { splitForSpeech, toSpeechText } from './speech-text'

const placeholders = { code: 'Code skipped.', table: 'Table skipped.', link: 'link' }

describe('toSpeechText', () => {
  it('replaces code blocks, and tables when asked, with short cues', () => {
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
    expect(toSpeechText(markdown, placeholders, 'word-and-text', 'skip')).toBe(
      'Before. Table skipped. Code skipped. After.'
    )
  })

  describe('tables', () => {
    const markdown = [
      'Plan:',
      '| Day | Run |',
      '|:---|---:|',
      '| **Tue** | Intervals. |',
      '| Thu | [Easy](https://x.com/e) |',
      '',
      'After.'
    ].join('\n')
    const read = (mode: Parameters<typeof toSpeechText>[3], text = markdown) =>
      toSpeechText(text, placeholders, 'text', mode)

    it('reads each row with its column names', () => {
      expect(read('with-headers')).toBe(
        'Plan: Day: Tue, Run: Intervals. Day: Thu, Run: Easy. After.'
      )
    })

    it('can read the column names once and then only the values', () => {
      expect(read('values')).toBe('Plan: Day, Run. Tue, Intervals. Thu, Easy. After.')
    })

    it('leaves out empty cells and keeps escaped pipes in a cell', () => {
      const table = ['|  | A \\| B |', '|---|---|', '| x |  |', '| y | z |'].join('\n')
      expect(read('with-headers', table)).toBe('x. y, A | B: z.')
    })

    it('reads pipe rows without a delimiter row as values', () => {
      expect(read('with-headers', '| a | b |\n| c | d |')).toBe('a, b. c, d.')
    })

    it('does not take a line with a pipe over a rule for a table', () => {
      expect(read('with-headers', 'One | two\n---')).toBe('One | two. ---.')
    })
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

    it('leaves the brackets and punctuation around a bare address', () => {
      const read = (markdown: string) => toSpeechText(markdown, placeholders, 'word-and-text')
      expect(read('(see https://example.com) for more.')).toBe('(see link) for more.')
      expect(read('Open https://en.wikipedia.org/wiki/Foo_(bar), then')).toBe('Open link, then.')
      expect(read('Read [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) first.')).toBe(
        'Read link Foo first.'
      )
    })

    it('reads an image as its alt text, and drops one without', () => {
      const markdown = '![Build graph](docs/graph.png)\nBefore ![](x.png) after'
      expect(toSpeechText(markdown, placeholders, 'word-and-text')).toBe(
        'Build graph. Before after.'
      )
    })
  })

  it('keeps inline code that is not a path', () => {
    expect(toSpeechText('Run `pnpm test` now', placeholders)).toBe('Run pnpm test now.')
  })

  it('reads only the name of a path, and keeps word pairs and commands whole', () => {
    const read = (code: string) => toSpeechText(`See \`${code}\``, placeholders)
    expect(read('src/foo/plan-aktualny.md:12')).toBe('See plan aktualny.')
    expect(read('./scripts/build')).toBe('See build.')
    expect(read('C:\\Users\\me\\notes.txt')).toBe('See notes.')
    expect(read('and/or')).toBe('See and/or.')
    expect(read('TCP/IP')).toBe('See TCP/IP.')
    expect(read('GET /api/users')).toBe('See GET /api/users.')
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
