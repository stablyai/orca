import { describe, expect, it } from 'vitest'
import { createFlatJsonFieldSlot, scanFlatJsonObjectBuffer } from './flat-json-object-buffer-scan'

describe('scanFlatJsonObjectBuffer', () => {
  it('extracts requested string and primitive fields from valid flat ASCII JSON objects', () => {
    const line =
      '{"at":"2026-01-01T00:00:00.000Z","action":"existing","count":42,"ok":true,"err":null,"fileEventId":"abc123"}'
    const buf = Buffer.from(line, 'utf-8')
    const action = createFlatJsonFieldSlot('action')
    const fileEventId = createFlatJsonFieldSlot('fileEventId')
    const count = createFlatJsonFieldSlot('count')
    expect(scanFlatJsonObjectBuffer(buf, 0, buf.length, [action, fileEventId, count])).toBe(true)
    expect(action.isString).toBe(true)
    expect(buf.toString('utf-8', action.valueStart, action.valueEnd)).toBe('existing')
    expect(fileEventId.isString).toBe(true)
    expect(buf.toString('utf-8', fileEventId.valueStart, fileEventId.valueEnd)).toBe('abc123')
    expect(count.isString).toBe(false)
    expect(buf.toString('utf-8', count.valueStart, count.valueEnd)).toBe('42')
  })

  it('uses last-value-wins for duplicate keys including non-string overwrites', () => {
    const line = '{"action":"existing","action":null,"fileEventId":"first","fileEventId":"second"}'
    const buf = Buffer.from(line, 'utf-8')
    const action = createFlatJsonFieldSlot('action')
    const fileEventId = createFlatJsonFieldSlot('fileEventId')
    expect(scanFlatJsonObjectBuffer(buf, 0, buf.length, [action, fileEventId])).toBe(true)
    expect(action.isString).toBe(false)
    expect(fileEventId.isString).toBe(true)
    expect(buf.toString('utf-8', fileEventId.valueStart, fileEventId.valueEnd)).toBe('second')
  })

  it('returns false on escapes, nested values, non-ASCII bytes, or torn/malformed JSON', () => {
    const cases = [
      '{"action":"existing","source":"C:\\\\dir\\\\file"}',
      '{"action":"existing","nested":{"a":1}}',
      '{"action":"existing","arr":[1,2]}',
      '{"action":"existing","path":"/tmp/café"}',
      '{"action":"existing","fileEventId":"abc"',
      '{"action":"existing",}',
      '{"count":01}',
      '{"action":"existing"} trailing',
      '[]'
    ]
    const action = createFlatJsonFieldSlot('action')
    for (const raw of cases) {
      const buf = Buffer.from(raw, 'utf-8')
      expect(scanFlatJsonObjectBuffer(buf, 0, buf.length, [action])).toBe(false)
    }
  })
})
