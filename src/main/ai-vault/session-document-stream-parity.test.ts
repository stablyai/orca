import { describe, it, expect } from 'vitest'
import {
  parseHermesSessionContent,
  parseHermesSessionDocument
} from './session-scanner-hermes-parser'
import { parseDevinSessionContent, parseDevinSessionDocument } from './session-scanner-devin-parser'
import {
  parseGeminiSessionContent,
  parseGeminiSessionDocument
} from './session-scanner-gemini-parsers'
import {
  parseClineSessionContent,
  parseClineSessionDocuments
} from './session-scanner-cline-parser'

const file = {
  path: '/sessions/identity/identity.json',
  mtimeMs: 1000,
  modifiedAt: new Date(1000).toISOString()
}

const options = { executionHostId: 'ssh:parity' as const, executionHostPlatform: 'darwin' as const }

async function* bytes(content: string) {
  const data = Buffer.from(content)

  for (let i = 0; i < data.length; i += 3) {
    yield data.subarray(i, i + 3)
  }
}

const fixtures = [
  {
    agent: 'hermes',
    parse: parseHermesSessionContent,
    stream: parseHermesSessionDocument,
    content:
      '{"messages":[{"role":"user","content":"Ü🐋 first"},{"role":"assistant","content":"answer"}],"session_id":"id","cwd":"/repo","model":"root","session_start":"2026-01-01T00:00:00Z","last_updated":"2026-01-02T00:00:00Z","message_count":99}'
  },
  {
    agent: 'devin',
    parse: parseDevinSessionContent,
    stream: parseDevinSessionDocument,
    content:
      '{"steps":[{"role":"assistant","text":"answer","metadata":{"generation_model":"step","created_at":"2026-01-02T00:00:00Z","metrics":{"input_tokens":10,"output_tokens":20}}},{"metadata":{"is_user_input":true},"text":"Ü🐋 prompt"}],"agent":{"model_name":"root"},"session_id":"id","working_directory":"/repo"}'
  },
  {
    agent: 'gemini',
    parse: parseGeminiSessionContent,
    stream: parseGeminiSessionDocument,
    content:
      '{"messages":[{"type":"user","content":"Ü🐋 first","timestamp":"2026-01-02T00:00:00Z"},{"type":"gemini","content":"answer","tokens":{"input":10,"output":20}}],"sessionId":"id","startTime":"2026-01-01T00:00:00Z","lastUpdated":"2026-01-03T00:00:00Z"}'
  }
]

describe('streamed whole-document parser equivalence', () => {
  for (const fixture of fixtures) {
    it(`${fixture.agent}: field order and UTF8 chunk boundaries preserve every output field`, async () => {
      expect(await fixture.stream(file, bytes(fixture.content), 'darwin', options)).toEqual(
        await fixture.parse(file, fixture.content, 'darwin', options)
      )
    })

    for (const last of [
      '[]',
      'null',
      '[{"role":"user","type":"user","content":"last","text":"last","metadata":{"is_user_input":true}}]'
    ]) {
      it(`${fixture.agent}: duplicate arrays use their final value ${last}`, async () => {
        const key = fixture.agent === 'devin' ? 'steps' : 'messages'
        const content = `${fixture.content.slice(0, -1)},"${key}":${last}}`
        expect(await fixture.stream(file, bytes(content), 'darwin', options)).toEqual(
          await fixture.parse(file, content, 'darwin', options)
        )
      })
    }

    it(`${fixture.agent}: rejects a malformed tail after valid messages`, async () => {
      const content = fixture.content.slice(0, -1)
      await expect(fixture.stream(file, bytes(content), 'darwin', options)).rejects.toThrow()
    })
  }

  it('Cline preserves sidecar semantics, metadata field order and duplicate arrays', async () => {
    const metadata =
      '{"session_id":"id","cwd":"/repo","started_at":"2026-01-01T00:00:00Z","prompt":"fallback"}'

    for (const messages of [
      '{"messages":[{"role":"user","content":"Ü🐋 first","ts":"2026-01-02T00:00:00Z"},{"role":"assistant","content":"answer","modelInfo":{"id":"sidecar"}}],"updated_at":"2026-01-03T00:00:00Z"}',
      '{"messages":[{"role":"user","content":"old"}],"messages":[]}',
      '{"messages":[{"role":"user","content":"partial"}]'
    ]) {
      expect(
        await parseClineSessionDocuments(
          file,
          bytes(metadata),
          () => bytes(messages),
          'darwin',
          options
        )
      ).toEqual(parseClineSessionContent(file, metadata, messages, 'darwin', options))
    }
  })
})
