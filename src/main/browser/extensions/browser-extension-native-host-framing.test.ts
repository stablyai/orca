import { endianness } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  createNativeHostMessageReader,
  encodeNativeHostMessage,
  MAX_NATIVE_HOST_MESSAGE_BYTES
} from './browser-extension-native-host-framing'

function header(size: number): Buffer {
  const bytes = Buffer.alloc(4)
  if (endianness() === 'LE') {
    bytes.writeUInt32LE(size)
  } else {
    bytes.writeUInt32BE(size)
  }
  return bytes
}

function frame(json: string): Buffer {
  const body = Buffer.from(json, 'utf8')
  return Buffer.concat([header(body.length), body])
}

function collect() {
  const messages: string[] = []
  const errors: string[] = []
  const reader = createNativeHostMessageReader(
    (json) => messages.push(json),
    (reason) => errors.push(reason)
  )
  return { reader, messages, errors }
}

describe('native host message framing', () => {
  it('prefixes the UTF-8 byte length, not the string length, in native byte order', () => {
    const json = JSON.stringify({ text: 'héllo 🦈' })
    const encoded = encodeNativeHostMessage(json)
    expect(encoded.subarray(0, 4)).toEqual(header(Buffer.byteLength(json)))
    expect(Buffer.byteLength(json)).toBeGreaterThan(json.length)
    expect(encoded.subarray(4).toString('utf8')).toBe(json)
  })

  it('reassembles a message split across chunks, including inside the header and a character', () => {
    const { reader, messages } = collect()
    const bytes = frame(JSON.stringify({ text: '🦈🦈' }))
    for (const cut of [1, 3, 6, 9]) {
      reader.push(bytes.subarray(0, cut))
      reader.push(bytes.subarray(cut))
    }
    expect(messages).toEqual(Array(4).fill('{"text":"🦈🦈"}'))
  })

  it('delivers every message in one chunk, in order', () => {
    const { reader, messages } = collect()
    reader.push(Buffer.concat([frame('1'), frame('{"a":2}'), frame('"three"')]))
    expect(messages).toEqual(['1', '{"a":2}', '"three"'])
  })

  it('takes a message of exactly 1 MB and refuses one byte more without waiting for it', () => {
    const exact = collect()
    const body = `"${'x'.repeat(MAX_NATIVE_HOST_MESSAGE_BYTES - 2)}"`
    exact.reader.push(frame(body))
    expect(exact.messages).toHaveLength(1)

    const over = collect()
    expect(over.reader.push(header(MAX_NATIVE_HOST_MESSAGE_BYTES + 1))).toBe(false)
    expect(over.errors).toHaveLength(1)
    expect(over.reader.push(frame('1'))).toBe(false)
    expect(over.messages).toEqual([])
  })

  it('stops at a message that is not JSON', () => {
    const { reader, messages, errors } = collect()
    reader.push(Buffer.concat([frame('{"ok":1}'), frame('{not json'), frame('2')]))
    expect(messages).toEqual(['{"ok":1}'])
    expect(errors).toEqual(['message is not valid JSON'])
  })
})
