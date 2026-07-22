import { describe, expect, it, vi } from 'vitest'
import { briefToolArg, summarizeToolInput, toolFilePath } from './mobile-native-chat-tool-summary'

describe('summarizeToolInput', () => {
  it('passes short strings through, collapsing whitespace', () => {
    expect(summarizeToolInput('ls   -la\n/tmp')).toBe('ls -la /tmp')
  })

  it('serializes objects to compact JSON', () => {
    expect(summarizeToolInput({ path: 'a.ts', limit: 5 })).toBe('{"path":"a.ts","limit":5}')
  })

  it('truncates long previews with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const out = summarizeToolInput(long)
    expect(out.length).toBe(80)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns empty string for null/undefined', () => {
    expect(summarizeToolInput(null)).toBe('')
    expect(summarizeToolInput(undefined)).toBe('')
  })

  it('handles numbers and booleans', () => {
    expect(summarizeToolInput(42)).toBe('42')
    expect(summarizeToolInput(true)).toBe('true')
  })

  it('does not traverse an unbounded tool-input object for a short preview', () => {
    const input: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 8 }, (_unused, index) => [`key${index}`, index])
    )
    const lateGetter = vi.fn(() => 'should not be read')
    Object.defineProperty(input, 'late', { enumerable: true, get: lateGetter })

    expect(summarizeToolInput(input)).not.toBe('')
    expect(lateGetter).not.toHaveBeenCalled()
  })
})

describe('toolFilePath', () => {
  it('extracts file_path / filePath / path / notebook_path', () => {
    expect(toolFilePath({ file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(toolFilePath({ filePath: 'src/b.ts' })).toBe('src/b.ts')
    expect(toolFilePath({ path: 'src/c.ts' })).toBe('src/c.ts')
    expect(toolFilePath({ notebook_path: 'n.ipynb' })).toBe('n.ipynb')
  })
  it('returns null when there is no file target', () => {
    expect(toolFilePath({ command: 'ls' })).toBeNull()
    expect(toolFilePath('x')).toBeNull()
    expect(toolFilePath(null)).toBeNull()
  })
})

describe('briefToolArg', () => {
  it('takes the basename of a forward-slash path', () => {
    expect(briefToolArg({ path: 'src/session/app.ts' })).toBe('app.ts')
  })

  it('takes the basename of a Windows backslash path from a raw transcript', () => {
    expect(briefToolArg({ file_path: 'C:\\Users\\me\\project\\app.tsx' })).toBe('app.tsx')
  })
})
