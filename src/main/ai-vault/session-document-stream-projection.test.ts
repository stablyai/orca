import { describe, it, expect } from 'vitest'
import { parseDevinSessionContent, parseDevinSessionDocument } from './session-scanner-devin-parser'
import { readStreamedSessionDocument } from './session-document-stream'

const file = { path: '/devin/test.json', modifiedAt: new Date(0).toISOString(), mtimeMs: 0 }

const options = {
  executionHostId: 'ssh:projection' as const,
  executionHostPlatform: 'darwin' as const
}

async function* bytes(content: string) {
  const b = Buffer.from(content)

  for (let i = 0; i < b.length; i += 7) {
    yield b.subarray(i, i + 7)
  }
}

describe('Devin consumed metadata projection', () => {
  for (const suffix of [
    '{}',
    'null',
    '[]',
    '{"model":"last"}',
    '{"model_name":"last-name","model":"fallback"}',
    '{"model_name":[],"model":123}',
    '{"model":"old","model":"last"}'
  ]) {
    it(`preserves duplicate root agent ${suffix}`, async () => {
      const content = `{"agent":{"model_name":"old"},"steps":[{"role":"assistant","text":"message","metadata":{"generation_model":"step"}}],"generation_model":"root-fallback","agent":${suffix}}`
      expect(await parseDevinSessionDocument(file, bytes(content), 'darwin', options)).toEqual(
        parseDevinSessionContent(file, content, 'darwin', options)
      )
    })
  }

  it('retains only model fields from the agent object', async () => {
    const result = await readStreamedSessionDocument({
      bytes: bytes(
        '{"agent":{"ignored":{"many":[1,2,3]},"model_name":"root","model":"fallback"},"steps":[]}'
      ),
      arrayKey: 'steps',
      fields: [],
      objectFields: { agent: ['model_name', 'model'] },
      create: () => 0,
      consume: () => {}
    })

    expect(result).toEqual({
      record: { agent: { model_name: 'root', model: 'fallback' } },
      state: 0
    })
  })
})
