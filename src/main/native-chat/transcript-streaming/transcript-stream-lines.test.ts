import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { splitTranscriptStreamLines } from './transcript-stream-lines'

describe('bounded transcript records', () => {
  async function collect(chunks: (Buffer | string)[], limit: number) {
    const records: string[] = []
    for await (const record of splitTranscriptStreamLines(Readable.from(chunks), limit)) {
      records.push(record.line)
    }
    return records
  }

  it('resets the byte budget per record and accepts the exact limit', async () => {
    expect(await collect(['1234\n123', '4\n1234'], 4)).toEqual(['1234', '1234', '1234'])
  })

  it('counts UTF-8 bytes across split codepoints', async () => {
    const bytes = Buffer.from('😀é')
    const chunks = [bytes.subarray(0, 2), bytes.subarray(2, 5), bytes.subarray(5)]
    expect((await collect(chunks, 6))[0]).toBe('😀é')
    await expect(collect(chunks, 5)).rejects.toThrow('record exceeds 5 byte limit')
    expect((await collect(['\ud83d', '\ude00'], 4))[0]).toBe('😀')
  })

  it('checks the decoder tail before emitting it', async () => {
    await expect(collect([Buffer.from([0x61, 0xf0, 0x9f])], 3)).rejects.toThrow(
      'record exceeds 3 byte limit'
    )
  })
})
