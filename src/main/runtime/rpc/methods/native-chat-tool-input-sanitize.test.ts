import { describe, expect, it } from 'vitest'
import {
  createToolInputDisplay,
  summarizeToolInput,
  toolFilePath
} from '../../../../shared/native-chat-tool-summary'
import { sanitizeToolInput } from './native-chat-tool-input-sanitize'
import { inputWork } from './native-chat-tool-input-projection'

function wire(value: unknown, string: boolean): unknown {
  return JSON.parse(
    JSON.stringify({ input: sanitizeToolInput(string ? JSON.stringify(value) : value) })
  ).input
}
function structure(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}
function budget(value: unknown): { chars: number; nodes: number; slots: number; depth: number } {
  const result = {
    chars: typeof value === 'string' ? value.length : 0,
    nodes: 1,
    slots: 0,
    depth: 0
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    result.slots = entries.length
    for (const [key, item] of entries) {
      const child = budget(item)
      result.chars += child.chars + (Array.isArray(value) ? 0 : key.length)
      result.nodes += child.nodes
      result.slots = Math.max(result.slots, child.slots)
      result.depth = Math.max(result.depth, child.depth + 1)
    }
  }
  return result
}
const families: [string, Record<string, unknown>, string | null][] = [
  ['query string', { query: 'needle' }, 'query'],
  ['pattern string', { pattern: 'needle' }, 'pattern'],
  ['query argv', { query: ['alpha', 'beta'] }, 'query'],
  ['pattern argv', { pattern: ['alpha', 'beta'] }, 'pattern'],
  ['both nonblank', { query: 'needle', pattern: 'alternate' }, 'query'],
  ['blank query argv', { query: [''], pattern: 'needle' }, 'pattern'],
  ['whitespace query argv', { query: [' ', ''], pattern: ['alpha', 'beta'] }, 'pattern'],
  ['blank query', { query: '  ', pattern: 'needle' }, 'pattern'],
  ['empty query', { query: [], pattern: 'needle' }, 'pattern'],
  ['mixed query', { query: ['x', 0], pattern: 'needle' }, 'pattern'],
  ['mixed pattern', { query: 'needle', pattern: ['x', 0] }, 'query'],
  ['invalid query', { query: 17, pattern: 'needle' }, 'pattern'],
  ['whitespace', { query: '  needle  ' }, 'query'],
  ['oversized', { query: 'x'.repeat(1020), pattern: 'alternate' }, null],
  ['unknown argv', { query: Array(21).fill('x'), pattern: 'alternate' }, null],
  ['unknown blank', { query: Array(21).fill(''), pattern: 'alternate' }, null]
]
for (const key of ['query', 'pattern']) {
  for (const shape of ['string', 'argv']) {
    for (const cost of [1023, 1024, 1025]) {
      const text = 'x'.repeat(cost - key.length)
      families.push([
        `${key} ${shape} ${cost}`,
        {
          [key]: shape === 'argv' ? ['', text] : text,
          ...(key === 'query' ? { pattern: 'alternate' } : { query: [''] })
        },
        cost <= 1024 ? key : null
      ])
    }
  }
}
for (const length of [19, 20, 21]) {
  for (const key of ['query', 'pattern']) {
    families.push([
      `${key} length ${length}`,
      { [key]: Array(length).fill('x') },
      length <= 20 ? key : null
    ])
  }
}

describe('host structural tool input publication', () => {
  for (const [name, args, winner] of families) {
    for (const reverse of [false, true]) {
      for (const placement of ['early', 'bulk', 'wide']) {
        for (const string of [false, true]) {
          it(`${name} reverse=${reverse} ${placement} string=${string}`, () => {
            const metadata = Object.fromEntries(
              (reverse ? ['pattern', 'query'] : ['query', 'pattern'])
                .filter((key) => Object.hasOwn(args, key))
                .map((key) => [key, args[key]])
            )
            const bulk = { content: 'x'.repeat(5000) },
              wide = Object.fromEntries(
                Array.from({ length: 20 }, (_, i) => [`generic${i}`, 'value'])
              )
            const source =
              placement === 'early'
                ? { ...metadata, ...bulk }
                : placement === 'bulk'
                  ? { ...bulk, ...metadata }
                  : { ...wide, ...metadata, ...bulk }
            const input = { ...source, path: '/synthetic/root' }
            const output = wire(input, string)
            const projected = structure(output) as Record<string, unknown>
            const display = createToolInputDisplay(output)
            expect(typeof output).toBe(string ? 'string' : 'object')
            expect(display.filePath).toBeNull()
            if (winner) {
              expect(projected[winner]).toEqual(args[winner])
              expect(display.label).toBe(createToolInputDisplay(input).label)
            } else {
              expect(projected).not.toHaveProperty('query')
              expect(projected).not.toHaveProperty('pattern')
              expect(display.label).not.toBe('alternate')
            }
            const actual = budget(projected)
            expect(actual.chars).toBeLessThanOrEqual(4000)
            expect(actual.nodes).toBeLessThanOrEqual(100)
            expect(actual.slots).toBeLessThanOrEqual(20)
            expect(actual.depth).toBeLessThanOrEqual(5)
            expect(JSON.stringify(projected).length).toBeLessThanOrEqual(32768)
          })
        }
      }
    }
  }
  for (const string of [false, true]) {
    for (const [source, target] of [
      [{ content: 'x'.repeat(5000), file_path: '/right', path: '/wrong' }, '/right'],
      [{ file_path: 17, path: '/wrong', query: [''], pattern: 'needle' }, null],
      [{ file_path: '', filePath: '/wrong' }, null],
      [{ file_path: null, filePath: '/right', query: 'term' }, '/right'],
      [{ path: '/right', query: ['x', 0], pattern: [] }, '/right'],
      [{ path: '/scan', query: 'term' }, null],
      [{ path: '/scan', query: Array(21).fill(''), notebook_path: '/wrong' }, null],
      [{ file_path: ' ', query: 'term' }, ' '],
      [{ changes: [{ path: 17 }, { path: '/right' }] }, '/right'],
      [{ changes: [{ path: '' }, { path: '/wrong' }], query: 'term' }, null],
      [{ changes: [...Array.from({ length: 19 }, () => ({})), { path: '/right' }] }, '/right'],
      [{ changes: [...Array.from({ length: 20 }, () => ({})), { path: '/unsupported' }] }, null]
    ] as const) {
      it(`authority ${JSON.stringify(source).slice(-100)} string=${string}`, () => {
        const output = wire(source, string)
        expect(toolFilePath(output)).toBe(target)
        if (target !== null) {
          expect(createToolInputDisplay(output).label).toBe(createToolInputDisplay(source).label)
        }
      })
    }
  }
  it('uses own data without running getters or prototype setters in preview', () => {
    let calls = 0
    const source = Object.create({ file_path: '/inherited' })
    Object.defineProperty(source, 'query', {
      enumerable: true,
      get() {
        calls++
        return 'bad'
      }
    })
    Object.defineProperty(source, 'toJSON', {
      enumerable: true,
      value() {
        calls++
        return 'bad'
      }
    })
    Object.defineProperty(source, '__proto__', { enumerable: true, value: { safe: true } })
    source.pattern = 'needle'
    expect(toolFilePath(source)).toBeNull()
    expect(createToolInputDisplay(source).label).toBe('needle')
    expect(summarizeToolInput(source)).toContain('__proto__')
    const result = sanitizeToolInput(source) as object
    expect(Object.hasOwn(result, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(calls).toBe(0)
  })
  for (const length of [63999, 64000, 64001]) {
    it(`bounds acquisition ${length}`, () => {
      const value = `{"query":"needle","content":"${'x'.repeat(length - 31)}"}`
      expect(value.length).toBe(length)
      const work = inputWork()
      const result = sanitizeToolInput(value, work)
      expect(work.parses).toBe(length <= 64000 ? 1 : 0)
      expect(work.serializations).toBe(length <= 64000 ? 1 : 0)
      expect(work.openings).toBeLessThanOrEqual(100)
      expect(work.candidates).toBeLessThanOrEqual(2100)
      expect(work.fixedProbes).toBeLessThanOrEqual(190)
      if (length <= 64000) {
        expect(createToolInputDisplay(result).label).toBe('needle')
      } else {
        expect((result as string).length).toBeLessThanOrEqual(4000)
      }
    })
  }
})
