import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { startOfLastNonBlankLines } from './terminal-wait-tail-window'

let scratch = ''
let childPath = ''

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'orca-tail-window-'))
  childPath = join(scratch, 'leading-blank.cjs')
  await build({
    stdin: {
      contents: `
        import { startOfLastNonBlankLines } from './src/main/runtime/terminal-wait-tail-window';
        import { detectTerminalWaitBlockedReason, isKnownReadyPromptPreview } from './src/main/runtime/terminal-wait-detection';
        const tails = ['', '\\n', '\\n\\n', '\\ntext', '\\ntext\\n', '\\n \\t\\ntext\\n\\n'];
        process.stdout.write(JSON.stringify({
          offsets: tails.map(value => startOfLastNonBlankLines(value, 12)),
          blank: detectTerminalWaitBlockedReason('\\n\\n'),
          ordinary: detectTerminalWaitBlockedReason('\\nordinary output'),
          blocked: detectTerminalWaitBlockedReason('\\nDo you trust this workspace directory?\\n1. Yes\\n2. No'),
          ready: isKnownReadyPromptPreview('\\nOpenAI Codex\\nmodel: test\\ndirectory: /workspace')
        }));
      `,
      resolveDir: process.cwd()
    },
    outfile: childPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})

afterAll(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

describe('terminal wait nonblank tail window', () => {
  it('terminates on leading blank rows before classifying the remaining screen', async () => {
    // Isolate the synchronous regression so its timeout cannot block the test worker.
    const result = await runProcess({
      program: process.execPath,
      args: ['--max-old-space-size=64', childPath],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 2_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      offsets: [0, 0, 0, 0, 0, 0],
      blank: null,
      ordinary: null,
      blocked: 'agent-trust-workspace',
      ready: true
    })
  })

  it.each([
    { value: 'first\nsecond\nthird', count: 2, expected: 'second\nthird' },
    { value: 'first\n\n \t\nsecond\nthird\n', count: 2, expected: 'second\nthird\n' },
    { value: '\nfirst\nsecond', count: 1, expected: 'second' },
    { value: '\nfirst\nsecond', count: 2, expected: 'first\nsecond' },
    { value: 'first\nsecond', count: 3, expected: 'first\nsecond' },
    { value: 'first\nsecond\n\n', count: 1, expected: 'second\n\n' },
    { value: ' \t\r\nsecond', count: 2, expected: ' \t\r\nsecond' }
  ])('selects the last $count nonblank rows of $value', ({ value, count, expected }) => {
    expect(value.slice(startOfLastNonBlankLines(value, count))).toBe(expected)
  })
})
