import { describe, expect, it } from 'vitest'
import {
  compactTerminalHeuristic,
  foldRepetitiveLines,
  formatCodeAndDiffBlocks,
  formatTerminalHuman,
  parseTerminalToMessages,
  stripAnsiAndCarriageReturns
} from './terminal-human-formatter'

describe('terminal-human-formatter', () => {
  describe('stripAnsiAndCarriageReturns', () => {
    it('strips ANSI color and cursor codes', () => {
      const raw = '\x1b[32m✔ Loaded config\x1b[0m\n\x1b[2K\x1b[1ADone.'
      const cleaned = stripAnsiAndCarriageReturns(raw)
      expect(cleaned).toBe('✔ Loaded config\nDone.')
    })

    it('resolves carriage-return overwrites from progress bars', () => {
      const raw = 'Downloading 10%\rDownloading 50%\rDownloading 100%'
      const cleaned = stripAnsiAndCarriageReturns(raw)
      expect(cleaned).toBe('Downloading 100%')
    })

    it('strips OSC window title codes', () => {
      const raw = '\x1b]0;fish /Users/cis2042\x07Hello World'
      const cleaned = stripAnsiAndCarriageReturns(raw)
      expect(cleaned).toBe('Hello World')
    })
  })

  describe('foldRepetitiveLines', () => {
    it('folds 4 identical lines into a summary', () => {
      const lines = [
        'waiting for build...',
        'waiting for build...',
        'waiting for build...',
        'waiting for build...',
        'done.'
      ]
      const folded = foldRepetitiveLines(lines, 3)
      expect(folded.length).toBe(3)
      expect(folded[0]).toBe('waiting for build...')
      expect(folded[1]).toContain('[repeated 3 more times: "waiting for build..."]')
      expect(folded[2]).toBe('done.')
    })

    it('does not fold lines below threshold', () => {
      const lines = ['line A', 'line A', 'line B']
      const folded = foldRepetitiveLines(lines, 3)
      expect(folded).toEqual(lines)
    })
  })

  describe('formatCodeAndDiffBlocks', () => {
    it('frames markdown code fences with box characters and line numbers', () => {
      const input = [
        'Here is the implementation:',
        '```typescript',
        'export function add(a: number, b: number) {',
        '  return a + b;',
        '}',
        '```',
        'End of message.'
      ]
      const formatted = formatCodeAndDiffBlocks(input)
      expect(formatted.some((l) => l.includes('╭── [typescript]'))).toBe(true)
      expect(formatted.some((l) => l.includes('│ 1 │ export function add'))).toBe(true)
      expect(formatted.some((l) => l.includes('╰───'))).toBe(true)
      expect(formatted[0]).toBe('Here is the implementation:')
      expect(formatted.at(-1)).toBe('End of message.')
    })

    it('frames git diffs with clean headers', () => {
      const input = [
        'diff --git a/index.ts b/index.ts',
        '--- a/index.ts',
        '+++ b/index.ts',
        '@@ -1,2 +1,3 @@',
        ' const a = 1;',
        '+const b = 2;',
        'Finished patch.'
      ]
      const formatted = formatCodeAndDiffBlocks(input)
      expect(formatted.some((l) => l.includes('╭── Diff: index.ts'))).toBe(true)
      expect(formatted.some((l) => l.includes('│ +const b = 2;'))).toBe(true)
      expect(formatted.some((l) => l.includes('╰───'))).toBe(true)
    })
  })

  describe('parseTerminalToMessages & compaction', () => {
    it('parses user prompts, assistant thoughts, and commands into messages', () => {
      const lines = [
        '> please check git status',
        'Checking repository status now...',
        '$ git status',
        'On branch main',
        'nothing to commit, working tree clean'
      ]
      const messages = parseTerminalToMessages(lines)
      expect(messages.length).toBeGreaterThan(0)
      expect(messages.some((m) => m.role === 'user')).toBe(true)
      expect(messages.some((m) => m.toolUses.length > 0)).toBe(true)
    })

    it('compacts intermediate large tool results while keeping code', () => {
      const lines = [
        '> task start',
        '$ pnpm build',
        'A'.repeat(500),
        '> next prompt',
        '$ git diff',
        'diff --git a/x.ts b/x.ts',
        '+const code = true;',
        '> final turn',
        'All set!'
      ]
      const messages = parseTerminalToMessages(lines)
      const { messages: compacted, stats } = compactTerminalHeuristic(messages, 2, 100)
      expect(compacted.length).toBeGreaterThan(0)
      expect(stats.resultsDropped).toBeGreaterThanOrEqual(1)
      expect(stats.charsAfter).toBeLessThan(stats.charsBefore)
    })
  })

  describe('formatTerminalHuman', () => {
    it('returns raw text when raw option is enabled', async () => {
      const raw = '\x1b[31mError\x1b[0m\n```ts\ncode\n```'
      const output = await formatTerminalHuman(raw, { raw: true })
      expect(output).toBe(raw)
    })

    it('formats code and cleans ANSI by default', async () => {
      const input = '\x1b[32mSuccess\x1b[0m\n```ts\nconst x = 1\n```'
      const output = await formatTerminalHuman(input)
      expect(output).not.toContain('\x1b[32m')
      expect(output).toContain('╭── [ts]')
      expect(output).toContain('│ 1 │ const x = 1')
    })

    it('performs fast-jev compaction when compact option is true', async () => {
      const input = [
        '> Run tests',
        '$ pnpm test',
        'test line '.repeat(100),
        '> All done',
        'Ready!'
      ].join('\n')

      const output = await formatTerminalHuman(input, { compact: true })
      expect(output).toContain('[fast-jev-compaction')
      expect(output).toContain('Tool: pnpm')
    })
  })
})
