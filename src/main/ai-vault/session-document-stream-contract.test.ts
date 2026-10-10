import { describe, expect, it } from 'vitest'
import { readStreamedSessionDocument } from './session-document-stream'

async function* bytes(content: string, chunkSize = 7): AsyncGenerator<Buffer> {
  const buffer = Buffer.from(content)
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    yield buffer.subarray(offset, offset + chunkSize)
  }
}

function read(
  content: string,
  overrides: Partial<Parameters<typeof readStreamedSessionDocument<unknown[]>>[0]> = {}
) {
  return readStreamedSessionDocument({
    bytes: bytes(content),
    arrayKey: 'messages',
    fields: ['id'],
    objectFields: { agent: ['model'] },
    create: (): unknown[] => [],
    consume: (state, value) => {
      state.push(value)
    },
    ...overrides
  })
}

describe('streamed session document contracts', () => {
  it.each(['[]', 'null', 'false', '0', '"not an array"', '{}'])(
    'a later messages value %s clears an earlier fold',
    async (last) => {
      expect(await read(`{"messages":[1,2],"messages":${last}}`)).toEqual({ record: {}, state: [] })
    }
  )

  it('replaces a failed earlier array and continues with its successor', async () => {
    const consume = (state: unknown[], value: unknown): void => {
      if (value === 'bad') {
        throw new Error('discarded failure')
      }
      state.push(value)
    }
    expect(await read('{"messages":["bad",1],"messages":[2,3]}', { consume })).toEqual({
      record: {},
      state: [2, 3]
    })
    expect(await read('{"messages":["bad"],"messages":[]}', { consume })).toEqual({
      record: {},
      state: []
    })
  })

  it('keeps the first consumer failure unless a later array replaces it', async () => {
    const failure = new Error('consumer failed')
    let calls = 0
    await expect(
      read('{"messages":[1,2]}', {
        consume: () => {
          calls++
          throw failure
        }
      })
    ).rejects.toBe(failure)
    expect(calls).toBe(1)
  })

  it('gives malformed trailing JSON precedence over a consumer failure', async () => {
    await expect(
      read('{"messages":[1]} trailing', {
        consume: () => {
          throw new Error('consumer')
        }
      })
    ).rejects.toBeInstanceOf(SyntaxError)
  })

  it('keeps projected object resets and full-field overlap precedence', async () => {
    expect(await read('{"agent":{"model":"old"},"agent":null}')).toEqual({
      record: { agent: {} },
      state: []
    })
    expect(await read('{"agent":{"model":"m","extra":[1,2]}}', { fields: ['agent'] })).toEqual({
      record: { agent: { model: 'm', extra: [1, 2] } },
      state: []
    })
    expect(await read('{"messages":[1,2]}', { objectFields: { messages: ['model'] } })).toEqual({
      record: { messages: {} },
      state: [1, 2]
    })
    expect(
      await read('{"messages":{"model":"m","ignored":1}}', {
        objectFields: { messages: ['model'] }
      })
    ).toEqual({ record: { messages: { model: 'm' } }, state: [] })
  })

  it('preserves selected prototype keys as own properties', async () => {
    const content =
      '{"id":{"__proto__":{"polluted":true}},"agent":{"model":{"constructor":"value","__proto__":{"x":1}}}}'
    const parsed = await read(content)
    expect(parsed?.record).toEqual(JSON.parse(content))
    expect(Object.getPrototypeOf(parsed?.record)).toBeNull()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it.each(['', ' ', '{', '{"messages":[1,]}', '{"messages":[]}{"messages":[]}'])(
    'rejects malformed input %j',
    async (content) => {
      await expect(read(content)).rejects.toBeInstanceOf(SyntaxError)
    }
  )

  it.each(['null', '[]', '[{}]', '123', '"text"', '"{}"'])(
    'does not publish a nonobject document %s',
    async (content) => {
      expect(await read(content)).toBeNull()
    }
  )

  it('recognizes an object root after whitespace and empty byte chunks', async () => {
    async function* padded() {
      yield Buffer.alloc(0)
      yield Buffer.from(' \t')
      yield Buffer.from('\r\n')
      yield Buffer.alloc(0)
      yield* bytes('{"id":"日本語😀","messages":[1]}', 1)
      yield Buffer.alloc(0)
      yield Buffer.from(' \n')
    }
    expect(await read('', { bytes: padded() })).toEqual({
      record: { id: '日本語😀' },
      state: [1]
    })
  })

  it('validates discarded subtrees and closes their source on malformed input', async () => {
    let closed = false
    async function* malformed() {
      try {
        yield Buffer.from('{"ignored":[{"deep":1},]}')
        throw new Error('must not request another chunk')
      } finally {
        closed = true
      }
    }
    await expect(read('', { bytes: malformed() })).rejects.toBeInstanceOf(SyntaxError)
    expect(closed).toBe(true)
  })

  it('preserves source failure and closes the source even after a consumer failure', async () => {
    const failure = new Error('disk failure')
    let closed = false
    async function* failing() {
      try {
        yield Buffer.from('{"messages":[1]')
        throw failure
      } finally {
        closed = true
      }
    }
    await expect(
      read('', {
        bytes: failing(),
        consume: () => {
          throw new Error('consumer')
        }
      })
    ).rejects.toBe(failure)
    expect(closed).toBe(true)
  })

  it('preserves escaped astral text across large and byte-sized chunks', async () => {
    const value = `${'x'.repeat(65530)}日本語😀\\literal`
    const content = JSON.stringify({ messages: [value, '\ud800', '\udc00'] })
    for (const size of [1, 65536, content.length * 4]) {
      expect(await read(content, { bytes: bytes(content, size) })).toEqual({
        record: {},
        state: [value, '\ud800', '\udc00']
      })
    }
  })
})
