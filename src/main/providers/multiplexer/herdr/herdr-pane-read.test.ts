import { describe, expect, it } from 'vitest'
import { buildPaneReadResult, stripAnsiEscape } from './herdr-pane-read'

const base = {
  pane_id: 'p1',
  workspace_id: 'w1',
  tab_id: 't1',
  revision: 5,
  rows: 30
}

describe('stripAnsiEscape', () => {
  it('removes CSI color sequences and keeps plain text', () => {
    expect(stripAnsiEscape('\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[22m')).toBe('red and bold')
  })

  it('removes OSC title sequences and cursor moves', () => {
    expect(stripAnsiEscape('\x1b]0;title\x07tail\x1b[2A')).toBe('tail')
  })

  it('leaves plain output untouched', () => {
    expect(stripAnsiEscape('plain\r\nline2')).toBe('plain\r\nline2')
  })
})

describe('buildPaneReadResult', () => {
  it('returns the visible window of rows for source visible', () => {
    const buffer = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n')
    const result = buildPaneReadResult({
      ...base,
      buffer,
      params: { pane_id: 'p1', source: 'visible' }
    })
    expect(result.text.split('\n')).toHaveLength(30)
    expect(result.text).toContain('line-10')
    expect(result.text).toContain('line-39')
    expect(result.text).not.toContain('line-9')
    expect(result.truncated).toBe(true)
  })

  it('respects an explicit lines window for source recent', () => {
    const buffer = Array.from({ length: 10 }, (_, i) => `line-${i}`).join('\n')
    const result = buildPaneReadResult({
      ...base,
      buffer,
      params: { pane_id: 'p1', source: 'recent', lines: 3 }
    })
    expect(result.text.split('\n')).toEqual(['line-7', 'line-8', 'line-9'])
    expect(result.truncated).toBe(true)
  })

  it('strips ANSI when format is text, keeps it when format is ansi', () => {
    const buffer = '\x1b[32mgreen\x1b[0m text'
    const text = buildPaneReadResult({
      ...base,
      buffer,
      params: { pane_id: 'p1', source: 'recent', format: 'text' }
    })
    expect(text.text).toBe('green text')
    expect(text.format).toBe('text')
    const ansi = buildPaneReadResult({
      ...base,
      buffer,
      params: { pane_id: 'p1', source: 'recent', format: 'ansi' }
    })
    expect(ansi.text).toContain('\x1b[32m')
    expect(ansi.format).toBe('ansi')
  })

  it('honors strip_ansi over the format', () => {
    const buffer = '\x1b[31mred\x1b[0m'
    const result = buildPaneReadResult({
      ...base,
      buffer,
      params: { pane_id: 'p1', source: 'recent', format: 'ansi', strip_ansi: true }
    })
    expect(result.text).toBe('red')
  })

  it('is not truncated when the buffer fits the window', () => {
    const buffer = 'one line'
    const result = buildPaneReadResult({
      ...base,
      buffer,
      params: { pane_id: 'p1', source: 'recent', lines: 5 }
    })
    expect(result.text).toBe('one line')
    expect(result.truncated).toBe(false)
  })

  it('carries the pane and revision metadata', () => {
    const result = buildPaneReadResult({
      ...base,
      buffer: 'hi',
      revision: 7,
      params: { pane_id: 'p1', source: 'recent' }
    })
    expect(result.pane_id).toBe('p1')
    expect(result.workspace_id).toBe('w1')
    expect(result.tab_id).toBe('t1')
    expect(result.revision).toBe(7)
    expect(result.source).toBe('recent')
  })

  it('preserves raw carriage returns for ansi-format reads', () => {
    const buffer = 'prompt\r\necho hi\r\nresult\rprompt'
    const ansi = buildPaneReadResult({
      ...base,
      buffer,
      params: { pane_id: 'p1', source: 'visible', format: 'ansi' }
    })
    expect(ansi.text).toContain('\r')
    expect(ansi.text).toContain('result\rprompt')

    const text = buildPaneReadResult({
      ...base,
      buffer,
      params: { pane_id: 'p1', source: 'visible', format: 'text' }
    })
    expect(text.text).not.toContain('\r')
  })
})
