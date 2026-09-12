import { describe, expect, it, vi } from 'vitest'
import { sanitizeToolInput } from './native-chat-tool-input-sanitize'
import {
  INPUT_MARKER,
  inputWork,
  OMIT_INPUT,
  ToolInputProjection
} from './native-chat-tool-input-projection'
import { sanitizeNativeChatRpcBlock } from './native-chat-rpc-block-sanitize'
import {
  createToolInputDisplay,
  summarizeToolInput
} from '../../../../shared/native-chat-tool-summary'

function nodes(value: unknown): number {
  return (
    1 +
    (value && typeof value === 'object'
      ? Object.values(value).reduce<number>((sum, child) => sum + nodes(child), 0)
      : 0)
  )
}

describe('tool projection hard boundaries', () => {
  for (const count of [99, 100, 101]) {
    it(`emits at most 100 nodes from ${count}`, () => {
      let remaining = count - 6
      const source = Array.from({ length: 5 }, () => {
        const size = Math.min(20, remaining)
        remaining -= size
        return Array(size).fill(0)
      })
      expect(nodes(source)).toBe(count)
      const work = inputWork(),
        output = sanitizeToolInput(source, work)
      expect(nodes(output)).toBe(Math.min(100, count))
      expect(work.openings).toBeLessThanOrEqual(100)
      expect(work.candidates).toBeLessThanOrEqual(2100)
    })
  }
  for (const count of [19, 20, 21]) {
    it(`includes markers inside ${count} source array slots`, () => {
      const output = sanitizeToolInput(Array(count).fill(0)) as unknown[]
      expect(output.length).toBe(Math.min(count, 20))
      if (count > 20) {
        expect(output.at(-1)).toBe(INPUT_MARKER)
      }
    })
  }
  for (const length of [127, 128, 129]) {
    it(`keeps key ${length} exact or absent`, () => {
      const key = 'k'.repeat(length),
        output = sanitizeToolInput({ [key]: 0 }) as object
      expect(Object.hasOwn(output, key)).toBe(length <= 128)
      expect(Object.keys(output).every((item) => item === key || item === '…')).toBe(true)
    })
  }
  for (const depth of [4, 5, 6]) {
    it(`bounds container depth ${depth}`, () => {
      let source: unknown = { leaf: true }
      for (let i = 0; i < depth; i++) {
        source = [source]
      }
      const output = sanitizeToolInput(source)
      expect(nodes(output)).toBeLessThanOrEqual(6)
      expect(JSON.stringify(output).includes('truncated')).toBe(depth >= 5)
    })
  }
  it('does not overwrite literal markers, including a late marker', () => {
    const source = Object.fromEntries([
      ...Array.from({ length: 21 }, (_, i) => [`k${i}`, i]),
      ['…', 'literal']
    ])
    expect(sanitizeToolInput(source)).not.toHaveProperty('…')
    expect(sanitizeToolInput({ '…': 'literal', body: 'x'.repeat(5000) })).toHaveProperty(
      '…',
      'literal'
    )
    expect(summarizeToolInput({ '…': 'literal', ...source })).not.toContain('"…":"…"')
  })
  it('charges marker strings and keeps surrogate pairs intact', () => {
    const output = sanitizeToolInput(`${'x'.repeat(3986)}😀${'x'.repeat(40)}`) as string
    expect(output.length).toBe(3999)
    expect(output.endsWith(INPUT_MARKER)).toBe(true)
    expect(output.charCodeAt(3985)).toBe(120)
  })
  for (const source of ['{bad', 'prose', '17', 'null', '"string"']) {
    it(`opaque fallback ${source}`, () => {
      const work = inputWork()
      expect(sanitizeToolInput(source, work)).toBe(source)
      expect(work.parses).toBe(source.startsWith('{') ? 1 : 0)
      expect(work.serializations).toBe(0)
    })
  }
  it('bounds deeply nested admitted parsing independently from projection', () => {
    const source = `${'['.repeat(31999)}0${']'.repeat(31999)}`
    const work = inputWork(),
      output = sanitizeToolInput(source, work)
    expect(work.parses).toBe(1)
    expect(work.openings).toBe(5)
    expect((output as string).length).toBeLessThan(100)
  })
  it('normalizes exotic values, active cycles and custom array properties safely', () => {
    const source: unknown[] & { query?: string; path?: string } = [
      undefined,
      () => 1,
      Symbol('x'),
      1n,
      Infinity,
      Number.NaN
    ]
    source.push(source)
    source.query = 'wrong'
    source.path = '/wrong'
    const output = sanitizeToolInput(source)
    expect(output).toEqual([null, null, null, null, null, null, INPUT_MARKER])
    expect(createToolInputDisplay(source).filePath).toBeNull()
    expect(createToolInputDisplay(output).filePath).toBeNull()
  })
  it('keeps escaped control and Unicode serialization within the enclosing input bound', () => {
    const input = { query: '\u0000\\"😀\ud800', content: '\u0000'.repeat(6000) }
    for (const source of [input, JSON.stringify(input)]) {
      const output = sanitizeToolInput(source)
      const inner = typeof output === 'string' ? output : JSON.stringify(output)
      const encoded = JSON.stringify(output),
        block = JSON.stringify({ type: 'tool-call', name: 'Search', input: output })
      expect(inner.length).toBeLessThanOrEqual(32768)
      expect(encoded.length).toBeLessThanOrEqual(196610)
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(589830)
      expect(block.length).toBeGreaterThan(encoded.length)
      expect(createToolInputDisplay(output).label).toBe(createToolInputDisplay(input).label)
    }
  })
  it('performs at most one fallback serialization on an invariant failure', () => {
    const original = JSON.stringify
    const spy = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => 'x'.repeat(32769))
    const work = inputWork()
    try {
      expect(sanitizeToolInput('[1]', work)).toBe('[]')
      expect(work.serializations).toBe(2)
    } finally {
      spy.mockRestore()
    }
    expect(JSON.stringify).toBe(original)
  })
  it('leaves nonmobile blocks identical', () => {
    const block = {
      type: 'tool-call' as const,
      name: 'Write',
      input: `{"content":"${'x'.repeat(10000)}"}`
    }
    expect(sanitizeNativeChatRpcBlock(block, 'runtime')).toBe(block)
  })
  it('charges rejected exact discriminators and caches source descriptor reads', () => {
    const nested: Record<string, unknown> = {
      key: Array.from({ length: 20 }, () => ({ child: Array(20).fill(0) }))
    }
    const source = { path: '/right', query: nested, pattern: nested, content: 'bulk' }
    const work = inputWork(),
      result = sanitizeToolInput(source, work)
    expect(createToolInputDisplay(result).filePath).toBeNull()
    expect(work.openings).toBeLessThanOrEqual(100)
    expect(work.candidates).toBeLessThanOrEqual(21 * work.openings)
    expect(work.fixedProbes).toBeLessThanOrEqual(190)
    expect(work.preflightVisits).toBeGreaterThan(90)
    expect(work.visits - work.preflightVisits!).toBe(1)
    expect(work.preflight?.candidates).toBe(work.candidates)
    expect(nodes(result)).toBeLessThanOrEqual(100)
  })
  it('measures preflight and emission separately without re-reading reserved argv', () => {
    const query = [' ', 'needle']
    const source = { content: 'bulk', query }
    const reads = vi.spyOn(Object, 'getOwnPropertyDescriptor')
    const work = inputWork()
    try {
      expect(sanitizeToolInput(source, work)).toEqual({ query, content: 'bulk' })
      expect(work.preflightVisits).toBe(3)
      expect(work.visits).toBe(5)
      for (const key of ['length', '0', '1']) {
        expect(
          reads.mock.calls.filter(([value, name]) => value === query && name === key)
        ).toHaveLength(1)
      }
    } finally {
      reads.mockRestore()
    }
  })
  it('does not repeat bounded whitespace scans for identical discriminators', () => {
    const work = inputWork()
    const blank = ' '.repeat(500)
    expect(sanitizeToolInput({ path: '/right', query: blank, pattern: blank }, work)).toEqual({
      path: '/right',
      query: blank,
      pattern: blank
    })
    expect(work.whitespace).toBe(500)
  })
  it('never refunds rejected exact work or opens containers after exhaustion', () => {
    const work = inputWork()
    const projection = new ToolInputProjection(work)
    const budget = { chars: 1024, nodes: 99 }
    const nested = { children: Array.from({ length: 20 }, () => Array(20).fill(0)) }
    expect(projection.project(nested, budget, 1, true)).toBe(OMIT_INPUT)
    expect(budget.nodes).toBe(0)
    const rejectedVisits = work.visits
    expect(projection.project(nested, budget, 1, true)).toBe(OMIT_INPUT)
    expect(work.visits).toBe(rejectedVisits + 1)
    const openingCount = work.openings
    for (let index = openingCount; index < 100; index++) {
      expect(projection.open({})).toBeDefined()
    }
    expect(projection.open({})).toBeUndefined()
    expect(work.openings).toBe(100)
    expect(work.candidates).toBeLessThanOrEqual(openingCount * 21)
  })
})
