import { expect, it } from 'vitest'
import { parseDevinSessionDocument } from '../scanners/devin/session-scanner-devin-parser'
import { parseGeminiSessionDocument } from '../scanners/gemini/session-scanner-gemini-parsers'
import { parseClineSessionDocuments } from '../scanners/cline/session-scanner-cline-parser'

const file = {
  path: '/sessions/identity/identity.json',
  mtimeMs: 1000,
  modifiedAt: new Date(1000).toISOString()
}
const options = { executionHostId: 'ssh:parity' as const, executionHostPlatform: 'darwin' as const }

async function* bytes(content: string): AsyncGenerator<Buffer> {
  const data = Buffer.from(content)
  for (let offset = 0; offset < data.length; offset += 3) {
    yield data.subarray(offset, offset + 3)
  }
}

it('reads Devin steps and the model stored in the agent record after them', async () => {
  const content =
    '{"steps":[{"role":"assistant","text":"answer","metadata":{"generation_model":"step","created_at":"2026-01-02T00:00:00Z","metrics":{"input_tokens":10,"output_tokens":20}}},{"metadata":{"is_user_input":true},"text":"Ü🐋 prompt"}],"agent":{"model_name":"root"},"session_id":"id","working_directory":"/repo"}'
  expect(await parseDevinSessionDocument(file, bytes(content), 'darwin', options)).toMatchObject({
    sessionId: 'id',
    title: 'Ü🐋 prompt',
    model: 'root',
    cwd: '/repo',
    messageCount: 2,
    totalTokens: 30
  })
})

it('reads Gemini messages and timestamps from the streamed document', async () => {
  const content =
    '{"messages":[{"type":"user","content":"Ü🐋 first","timestamp":"2026-01-02T00:00:00Z"},{"type":"gemini","content":"answer","tokens":{"input":10,"output":20}}],"sessionId":"id","startTime":"2026-01-01T00:00:00Z","lastUpdated":"2026-01-03T00:00:00Z"}'
  expect(await parseGeminiSessionDocument(file, bytes(content), 'darwin', options)).toMatchObject({
    sessionId: 'id',
    title: 'Ü🐋 first',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    messageCount: 2,
    totalTokens: 30
  })
})

it('reads Cline metadata and its separate messages document', async () => {
  const metadata =
    '{"session_id":"id","cwd":"/repo","started_at":"2026-01-01T00:00:00Z","prompt":"fallback"}'
  const messages =
    '{"messages":[{"role":"user","content":"Ü🐋 first","ts":"2026-01-02T00:00:00Z"},{"role":"assistant","content":"answer","modelInfo":{"id":"sidecar"}}],"updated_at":"2026-01-03T00:00:00Z"}'
  expect(
    await parseClineSessionDocuments(
      file,
      bytes(metadata),
      () => bytes(messages),
      'darwin',
      options
    )
  ).toMatchObject({
    sessionId: 'id',
    cwd: '/repo',
    title: 'Ü🐋 first',
    model: 'sidecar',
    updatedAt: '2026-01-03T00:00:00.000Z',
    messageCount: 2
  })
})
