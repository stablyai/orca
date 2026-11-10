import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeToolClose, readClaudeToolResult } from './claude-tool-result-close'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function transcript(...entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-claude-transcript-'))
  dirs.push(dir)
  const path = join(dir, 'session.jsonl')
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
  return path
}

const result = (id: string, content: unknown, isError?: boolean) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }]
  }
})

describe("Claude's tool_result for one tool call", () => {
  it('reads only that call, in either content shape', async () => {
    const path = transcript(
      result('toolu_old', 'use a script file', true),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_new' }] } },
      result('toolu_new', [{ type: 'text', text: '59' }])
    )
    expect(await readClaudeToolResult(path, 'toolu_new')).toEqual({ isError: false, text: '59' })
    expect(await readClaudeToolResult(path, 'toolu_none')).toBeNull()
    expect(await readClaudeToolResult(join(path, 'missing'), 'toolu_new')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'never opens a path that is not a regular file',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-claude-transcript-'))
      dirs.push(dir)
      const fifo = join(dir, 'fifo')
      execFileSync('mkfifo', [fifo])
      expect(await readClaudeToolResult(fifo, 'toolu_new')).toBeNull()
    }
  )

  it('credits Orca only with its own deny text, and names a No and the 2:00 block', () => {
    const deny = { isError: true, text: 'use a script file' }
    expect(claudeToolClose(deny, 'use a script file')).toBe('hook-denied')
    expect(claudeToolClose(deny, null)).toBe('other')
    expect(
      claudeToolClose(
        { isError: true, text: "The user doesn't want to proceed with this tool use. Rejected." },
        'use a script file'
      )
    ).toBe('user-denied')
    expect(
      claudeToolClose(
        { isError: true, text: 'Permission was denied by a built-in Claude Code safety check.' },
        null
      )
    ).toBe('auto-denied')
    expect(claudeToolClose({ isError: false, text: '59' }, 'use a script file')).toBe('ran')
  })
})
