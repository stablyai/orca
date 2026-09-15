import { describe, it, expect } from 'vitest'
import {
  parseHermesSessionContent,
  parseHermesSessionDocument
} from './session-scanner-hermes-parser'
import {
  parseClineSessionContent,
  parseClineSessionDocuments
} from './session-scanner-cline-parser'
import {
  remoteSessionContentLines,
  streamedSessionContentLines
} from './remote-session-content-lines'

const file = {
  path: '/fixture/session/session.json',
  mtimeMs: 0,
  modifiedAt: new Date(0).toISOString()
}
const options = {
  executionHostId: 'ssh:independent-review' as const,
  executionHostPlatform: 'linux' as const
}
async function* bytes(data: Buffer | string, size = 3) {
  const b = typeof data === 'string' ? Buffer.from(data) : data
  for (let i = 0; i < b.length; i += size) {
    yield b.subarray(i, i + size)
  }
}
async function outcome(run: () => unknown) {
  try {
    return { value: await run() }
  } catch (error) {
    return { error: error instanceof Error ? error.name : typeof error }
  }
}
async function lines(content: Iterable<string> | AsyncIterable<string>) {
  const result: string[] = []
  for await (const line of content) {
    result.push(line)
  }
  return result
}

describe('independent JSON boundary review', () => {
  for (const content of ['', ' \t\r\n']) {
    it(`preserves empty-document parse outcome ${JSON.stringify(content)}`, async () => {
      expect(
        await outcome(() => parseHermesSessionDocument(file, bytes(content), 'linux', options))
      ).toEqual(await outcome(() => parseHermesSessionContent(file, content, 'linux', options)))
    })
  }
  for (const invalid of [[255], [195], [237, 160, 128], [240, 128, 128, 128], [226, 40, 161]]) {
    it(`preserves legacy replacement decoding for UTF8 ${invalid.join('-')}`, async () => {
      const data = Buffer.concat([
        Buffer.from('{"session_id":"id","messages":[{"role":"user","content":"before '),
        Buffer.from(invalid),
        Buffer.from(' after"}]}')
      ])
      expect(
        await outcome(() => parseHermesSessionDocument(file, bytes(data, 1), 'linux', options))
      ).toEqual(
        await outcome(() =>
          parseHermesSessionContent(file, data.toString('utf8'), 'linux', options)
        )
      )
    })
  }
  it('ignores errors in an overwritten Cline messages array', async () => {
    const metadata = '{"session_id":"id","prompt":"fallback"}'
    const messages = '{"messages":[{"role":"user","content":"discarded","ts":1e300}],"messages":[]}'
    expect(
      await outcome(() =>
        parseClineSessionDocuments(file, bytes(metadata), () => bytes(messages), 'linux', options)
      )
    ).toEqual(
      await outcome(() => parseClineSessionContent(file, metadata, messages, 'linux', options))
    )
  })
  it('does not turn a bare carriage return into a JSONL record boundary', async () => {
    const content = '{"role":"user","content":"first"}\r{"role":"assistant","content":"second"}'
    expect(await lines(streamedSessionContentLines(bytes(content)))).toEqual(
      await lines(remoteSessionContentLines(content))
    )
  })
  it('preserves escaped surrogate, duplicate nested key, and prototype-looking key values', async () => {
    const content = String.raw`{"session_id":"id","__proto__":{"polluted":true},"messages":[{"role":"assistant","role":"user","content":"\ud800X\udc00 \ud83d\udc0b","__proto__":{"role":"assistant"}}]}`
    expect(await parseHermesSessionDocument(file, bytes(content, 1), 'linux', options)).toEqual(
      await parseHermesSessionContent(file, content, 'linux', options)
    )
    expect(Reflect.get({}, 'polluted')).toBeUndefined()
  })
  for (const content of [
    '{"messages":[],}',
    '{"messages":[1,]}',
    '{"messages":[01]}',
    '{"messages":[NaN]}',
    '{} {}'
  ]) {
    it(`rejects malformed JSON ${content}`, async () => {
      expect(
        await outcome(() => parseHermesSessionDocument(file, bytes(content), 'linux', options))
      ).toEqual(await outcome(() => parseHermesSessionContent(file, content, 'linux', options)))
    })
  }
})
