import { describe, expect, it } from 'vitest'
import { extractPreviewContentText } from './session-scanner-text-normalization'

describe('extractPreviewContentText', () => {
  it('renders a tool_use block as the tool name and its command', () => {
    expect(
      extractPreviewContentText([
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test src/foo' } }
      ])
    ).toBe('Bash: pnpm test src/foo')
  })

  it('falls back through file_path, pattern, and description inputs', () => {
    expect(
      extractPreviewContentText([
        { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }
      ])
    ).toBe('Read: /a/b.ts')
    expect(
      extractPreviewContentText([{ type: 'tool_use', name: 'Grep', input: { pattern: 'foo\\(' } }])
    ).toBe('Grep: foo\\(')
    expect(extractPreviewContentText([{ type: 'tool_use', name: 'Task', input: {} }])).toBe('Task')
  })

  it('interleaves tool calls with surrounding text and bounds the argument', () => {
    const long = 'x'.repeat(2000)
    const text = extractPreviewContentText([
      { type: 'text', text: 'Running tests.' },
      { type: 'tool_use', name: 'Bash', input: { command: long } }
    ])
    expect(text?.startsWith('Running tests. Bash: xxx')).toBe(true)
    expect(text?.length).toBeLessThan(long.length)
  })

  it('ignores a tool_use block with no name and no usable input', () => {
    expect(extractPreviewContentText([{ type: 'tool_use', input: { unrelated: 1 } }])).toBeNull()
  })
})
