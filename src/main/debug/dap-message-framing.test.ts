import { describe, expect, it } from 'vitest'
import { DapMessageDecoder, encodeDapMessage } from './dap-message-framing'

function collect(decoder: DapMessageDecoder): { messages: unknown[]; errors: Error[] } {
  const messages: unknown[] = []
  const errors: Error[] = []
  decoder.on('message', (msg) => messages.push(msg))
  decoder.on('error', (err) => errors.push(err))
  return { messages, errors }
}

describe('encodeDapMessage', () => {
  it('frames a message with a correct byte-length Content-Length header', () => {
    const message = { seq: 1, type: 'request', command: 'initialize' }
    const encoded = encodeDapMessage(message)
    const text = encoded.toString('utf8')
    const [header, body] = text.split('\r\n\r\n')
    const expectedLength = Buffer.byteLength(JSON.stringify(message), 'utf8')
    expect(header).toBe(`Content-Length: ${expectedLength}`)
    expect(Buffer.byteLength(body, 'utf8')).toBe(expectedLength)
    expect(JSON.parse(body)).toEqual(message)
  })

  it('counts UTF-8 byte length, not UTF-16 code-unit length, for multi-byte payloads', () => {
    const message = { msg: '日本語' }
    const encoded = encodeDapMessage(message)
    const text = encoded.toString('utf8')
    const [header, body] = text.split('\r\n\r\n')
    const declaredLength = Number(header.replace('Content-Length: ', ''))
    expect(declaredLength).toBe(Buffer.byteLength(body, 'utf8'))
    expect(declaredLength).toBeGreaterThan(JSON.stringify(message).length)
  })
})

describe('DapMessageDecoder', () => {
  it('decodes a single message delivered in one chunk', () => {
    const decoder = new DapMessageDecoder()
    const { messages } = collect(decoder)
    decoder.push(encodeDapMessage({ seq: 1, type: 'event', event: 'stopped' }))
    expect(messages).toEqual([{ seq: 1, type: 'event', event: 'stopped' }])
  })

  it('decodes a message split across many small chunks (byte-at-a-time)', () => {
    const decoder = new DapMessageDecoder()
    const { messages } = collect(decoder)
    const encoded = encodeDapMessage({ seq: 2, type: 'response', command: 'launch' })
    for (let i = 0; i < encoded.length; i += 1) {
      decoder.push(encoded.subarray(i, i + 1))
    }
    expect(messages).toEqual([{ seq: 2, type: 'response', command: 'launch' }])
  })

  it('decodes multiple messages delivered in a single chunk', () => {
    const decoder = new DapMessageDecoder()
    const { messages } = collect(decoder)
    const combined = Buffer.concat([
      encodeDapMessage({ seq: 1 }),
      encodeDapMessage({ seq: 2 }),
      encodeDapMessage({ seq: 3 })
    ])
    decoder.push(combined)
    expect(messages).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }])
  })

  it('emits an error and keeps decoding after a header missing Content-Length', () => {
    const decoder = new DapMessageDecoder()
    const { messages, errors } = collect(decoder)
    const badHeader = Buffer.from('X-Bogus: yes\r\n\r\n', 'ascii')
    decoder.push(Buffer.concat([badHeader, encodeDapMessage({ seq: 9 })]))
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('missing Content-Length')
    expect(messages).toEqual([{ seq: 9 }])
  })

  it('emits an error and keeps decoding after a body that fails to parse as JSON', () => {
    const decoder = new DapMessageDecoder()
    const { messages, errors } = collect(decoder)
    const badBody = Buffer.from('not json', 'utf8')
    const badMessage = Buffer.concat([
      Buffer.from(`Content-Length: ${badBody.length}\r\n\r\n`, 'ascii'),
      badBody
    ])
    decoder.push(Buffer.concat([badMessage, encodeDapMessage({ seq: 10 })]))
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('Malformed DAP body JSON')
    expect(messages).toEqual([{ seq: 10 }])
  })

  it('waits for the rest of the body when a chunk ends mid-message', () => {
    const decoder = new DapMessageDecoder()
    const { messages } = collect(decoder)
    const encoded = encodeDapMessage({ seq: 4, big: 'x'.repeat(500) })
    const splitPoint = Math.floor(encoded.length / 2)
    decoder.push(encoded.subarray(0, splitPoint))
    expect(messages).toEqual([])
    decoder.push(encoded.subarray(splitPoint))
    expect(messages).toHaveLength(1)
  })
})
