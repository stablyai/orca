import { describe, expect, it } from 'vitest'
import { TranscriptRecordBuffer } from './transcript-record-buffer'

describe('TranscriptRecordBuffer', () => {
  it('preserves UTF-8 across 100,000 one-byte fragments', () => {
    const expected = Buffer.from(`${'a'.repeat(99_996)}😀`)
    const record = new TranscriptRecordBuffer(expected.byteLength)

    for (const byte of expected) {
      record.append(Uint8Array.of(byte))
    }

    expect(record.byteLength).toBe(expected.byteLength)
    expect(record.toString()).toBe(expected.toString())
    expect(record.isOversized).toBe(false)
  })

  it('drops retained storage at the byte cap while tracking the full record length', () => {
    const record = new TranscriptRecordBuffer(4)

    record.append(Buffer.from('1234'))
    record.append(Buffer.from('56789'))
    record.append(Buffer.from('abc'))

    expect(record.byteLength).toBe(12)
    expect(record.toString()).toBe('')
    expect(record.isOversized).toBe(true)

    record.clear()
    record.append(Buffer.from('ok'))
    expect(record.toString()).toBe('ok')
  })
})
