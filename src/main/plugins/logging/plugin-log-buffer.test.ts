import { describe, expect, it } from 'vitest'
import { PluginLogBuffer } from './plugin-log-buffer'

describe('PluginLogBuffer.since', () => {
  it('returns only lines after the cursor, and every line for a stale one', () => {
    const logs = new PluginLogBuffer()
    logs.append('acme.notes', 'info', 'one')
    const first = logs.since('acme.notes')
    expect(first.lines.map((line) => line.line)).toEqual(['one'])
    logs.append('acme.other', 'info', 'elsewhere')
    logs.append('acme.notes', 'warn', 'two')
    const second = logs.since('acme.notes', first.cursor)
    expect(second.lines).toEqual([{ ts: expect.any(Number), level: 'warn', line: 'two' }])
    expect(logs.since('acme.notes', second.cursor).lines).toEqual([])
    expect(logs.since('acme.notes', 'other-run:999').lines).toHaveLength(2)
  })

  it('hands out a cursor before the plugin logged anything', () => {
    const logs = new PluginLogBuffer()
    const { cursor } = logs.since('acme.quiet')
    logs.append('acme.quiet', 'info', 'hello')
    expect(logs.since('acme.quiet', cursor).lines.map((line) => line.line)).toEqual(['hello'])
  })
})
