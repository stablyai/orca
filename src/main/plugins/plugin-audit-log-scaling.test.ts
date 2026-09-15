import { expect, it, vi } from 'vitest'
import { PluginAuditLog } from './plugin-audit-log'

const source = vi.hoisted(() => ({ content: '' }))
vi.mock('node:fs/promises', () => ({
  readFile: async (path: string) => (path.endsWith('.1') ? '' : source.content)
}))

it('extracts the recent window without splitting all historical log records', async () => {
  source.content = `${Array.from({ length: 10000 }, (_, ts) => JSON.stringify({ ts })).join('\n')}\n`
  const split = vi.spyOn(String.prototype, 'split')
  let entries: Awaited<ReturnType<PluginAuditLog['readRecent']>>
  try {
    entries = await new PluginAuditLog('/logs').readRecent(200)
    expect(split.mock.calls.length).toBe(0)
  } finally {
    split.mockRestore()
  }
  expect(entries!.map((entry) => entry.ts)).toEqual(
    Array.from({ length: 200 }, (_, index) => 9800 + index)
  )
})

it('preserves blank, malformed, unterminated and unusual-limit selection', async () => {
  source.content = '\n{"ts":1}\n\ninvalid\n \n{"ts":2}'
  const original = (limit: number) =>
    source.content
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
  const log = new PluginAuditLog('/logs')
  for (const limit of [1, 2, 3, 4, 5, 0, -1, 0.5, 1.5, Infinity, Number.NaN]) {
    expect(await log.readRecent(limit)).toEqual(original(limit))
  }
})

/** The pre-scan `split/filter/slice` selection, as the differential oracle. */
function referenceRecentLines(text: string, limit: number): string[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .slice(-limit)
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

it('selects the identical line set as the full split over randomized log shapes', async () => {
  const log = new PluginAuditLog('/logs')
  let nonEmptyCases = 0
  for (let seed = 1; seed <= 1500; seed += 1) {
    const random = makeRandom(seed)
    const pieces: string[] = []
    const lineCount = Math.floor(random() * 12)
    for (let i = 0; i < lineCount; i += 1) {
      const kind = random()
      // Blank lines, whitespace-only lines, CRLF rows, non-JSON rows and multi-byte
      // payloads all have to land on the same boundaries the split-based scan found.
      if (kind < 0.15) {
        pieces.push('')
      } else if (kind < 0.25) {
        pieces.push(' ')
      } else if (kind < 0.35) {
        pieces.push('not json')
      } else if (kind < 0.45) {
        pieces.push(`${JSON.stringify({ ts: i, summary: 'ünïcøde ✅' })}\r`)
      } else {
        pieces.push(JSON.stringify({ ts: i, actor: 'plugin:x' }))
      }
    }
    // Half the corpora end without a trailing newline (a torn final append).
    source.content = pieces.join('\n') + (random() < 0.5 ? '\n' : '')

    for (const limit of [1, 2, 3, 5, 200]) {
      const expected = referenceRecentLines(source.content, limit).flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
      expect(await log.readRecent(limit), `seed ${seed} limit ${limit}`).toEqual(expected)
      if (expected.length > 0) {
        nonEmptyCases += 1
      }
    }
  }
  expect(nonEmptyCases).toBeGreaterThan(1000)
})

it('never yields a record split across a line boundary', async () => {
  // A 200-record window from the tail of a file whose records are long and carry
  // escaped newlines: every returned line must still parse to one whole record.
  source.content = `${Array.from({ length: 3000 }, (_, ts) =>
    JSON.stringify({ ts, summary: `line\\nwith escapes ${'x'.repeat(200)}` })
  ).join('\n')}\n`
  const entries = await new PluginAuditLog('/logs').readRecent(200)
  expect(entries).toHaveLength(200)
  expect(entries.map((entry) => entry.ts)).toEqual(
    Array.from({ length: 200 }, (_, index) => 2800 + index)
  )
  expect(entries.every((entry) => entry.summary.endsWith('x'.repeat(200)))).toBe(true)
})
