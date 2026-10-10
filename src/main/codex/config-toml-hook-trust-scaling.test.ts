import type * as HookTrustBlocks from './config-toml-hook-trust-blocks'
import { expect, it, vi } from 'vitest'
import { upsertHookTrustContent } from './config-toml-hook-trust-edit'

const counts = vi.hoisted(() => ({ starts: 0 }))
vi.mock('./config-toml-hook-trust-blocks', async (importOriginal) => {
  const actual = await importOriginal<typeof HookTrustBlocks>()
  return {
    ...actual,
    findHookTrustBlockRanges: (...args: Parameters<typeof actual.findHookTrustBlockRanges>) =>
      actual.findHookTrustBlockRanges(...args).map((range) => ({
        ...range,
        get start() {
          counts.starts += 1
          return range.start
        }
      }))
  }
})

it('consumes monotonically scanned trust ranges without pairwise deduplication', () => {
  const header = '[hooks.state."/foo/hooks.json:pre_tool_use:0:0"]'
  const content = `${header}\nenabled = true\ntrusted_hash = "old"\n`.repeat(1000)
  counts.starts = 0
  const result = upsertHookTrustContent(content, [
    {
      sourcePath: '/foo/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: '/bin/echo hi',
      trustedHash: 'updated'
    }
  ])
  expect(counts.starts).toBeLessThan(5000)
  expect(result.split(header)).toHaveLength(2)
  expect(result).toContain('trusted_hash = "updated"')
})

// Dropping the old dedup+sort is only sound because the scanner advances its
// cursor past each block it emits. Pin that precondition: if a future scanner
// change lets ranges repeat or overlap, the upsert below would delete or widen
// a neighbouring trust block instead of rewriting just the matched one.
it('emits trust ranges with strictly ascending, non-overlapping spans', async () => {
  const { findHookTrustBlockRanges } = await vi.importActual<typeof HookTrustBlocks>(
    './config-toml-hook-trust-blocks'
  )
  const key = '/foo/hooks.json:pre_tool_use:0:0'
  const header = `[hooks.state."${key}"]`
  const contents = [
    '',
    header,
    `${header}\n${header}\n`,
    `${header}\nenabled = true\n`.repeat(50),
    `${header}\r\nenabled = true\r\n`.repeat(3),
    `[x]\nv = """\n${header}\n"""\n${header}\nenabled = true\n`,
    `[x]\na = [\n${header}\n]\n${header}\nenabled = true\n`,
    `${header}\nenabled = true\n[[arr]]\nz = 1\n${header}\n`
  ]
  for (const content of contents) {
    const ranges = findHookTrustBlockRanges(content, new Set([key]))
    for (const [index, range] of ranges.entries()) {
      expect(range.end).toBeGreaterThanOrEqual(range.start)
      expect(range.end).toBeLessThanOrEqual(content.length)
      if (index > 0) {
        expect(ranges[index - 1].start).toBeLessThan(range.start)
        expect(ranges[index - 1].end).toBeLessThanOrEqual(range.start)
      }
    }
    expect(new Set(ranges.map((range) => `${range.start}:${range.end}`)).size).toBe(ranges.length)
  }
})
