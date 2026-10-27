import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const JSON_PARSER_CASES = [
  { name: 'rg-10k', kind: 'rg', count: 10_000, cap: 2000 },
  { name: 'rg-100k', kind: 'rg', count: 100_000, cap: 2000 },
  { name: 'rg-100k-cap1', kind: 'rg', count: 100_000, cap: 1 },
  { name: 'rg-unicode', kind: 'rg', count: 10_000, cap: 2000, unicode: true },
  { name: 'rg-large-dense', kind: 'rg', count: 900_000, cap: 2000, large: true },
  { name: 'rg-fast-path', kind: 'rg', count: 1, cap: 2000, large: true },
  { name: 'session-messages', kind: 'session' },
  { name: 'session-skipped-objects', kind: 'session' },
  { name: 'session-skipped-string', kind: 'session' },
  { name: 'session-selected-string', kind: 'session' }
]

export function writeJsonParserFixtures(directory) {
  for (const fixture of JSON_PARSER_CASES) {
    let value
    if (fixture.kind === 'rg') {
      const text = fixture.unicode
        ? '\ufeff日本語😀x'
        : fixture.large && fixture.count > 1
          ? 'xxxx'
          : 'x'
      const matchBytes = Buffer.byteLength(text)
      value = {
        type: 'match',
        data: {
          path: { text: `${text}.ts` },
          lines: {
            text: text.repeat(fixture.count === 1 ? 4 * 1024 * 1024 : fixture.count)
          },
          line_number: 1,
          submatches: Array.from({ length: fixture.count }, (_, index) => ({
            match: { text },
            start: index * matchBytes,
            end: (index + 1) * matchBytes
          }))
        }
      }
    } else {
      value = { id: 'synthetic', messages: [{ text: 'one' }] }
      if (fixture.name === 'session-messages') {
        value.agent = { model: 'model', other: 'ignored' }
        value.messages = Array.from({ length: 20_000 }, (_, index) => ({
          role: index % 2 ? 'assistant' : 'user',
          text: '\ufeff日本語😀 hello world '.repeat(16),
          timestamp: index,
          metadata: { model: 'synthetic', tokens: 512 }
        }))
      } else if (fixture.name === 'session-skipped-objects') {
        value.ignored = Array.from({ length: 200_000 }, (_, index) => ({
          id: index,
          data: { text: 'x'.repeat(64), values: [1, 2, 3] }
        }))
      } else if (fixture.name === 'session-skipped-string') {
        value.ignored = '日本語😀x'.repeat(1_500_000)
      } else {
        value.messages = [{ text: '日本語😀x'.repeat(1_500_000) }]
      }
    }
    writeFileSync(join(directory, `${fixture.name}.json`), JSON.stringify(value))
  }
}
