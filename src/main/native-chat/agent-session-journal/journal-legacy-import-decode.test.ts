import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { decodeLegacyTranscriptImport } from './journal-legacy-import-decode'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-import-parse-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('preserves nonempty-line fallback identity and full-source metadata', async () => {
  const filePath = join(root, 'claude.jsonl')
  await writeFile(
    filePath,
    `${JSON.stringify({
      type: 'metadata',
      sessionId: 'session',
      cwd: root
    })}\n{bad\n\r\n${JSON.stringify({
      type: 'user',
      cwd: '/other',
      message: { content: 'hello' }
    })}`
  )
  const prepared = await decodeLegacyTranscriptImport(
    {
      agent: 'claude',
      transcriptAgent: 'claude',
      filePath,
      sessionId: 'session',
      limits: { inlineHeadBytes: 16384 },
      validateSource: true
    },
    async (observed) => {
      expect(observed).toEqual({ sessionId: 'session', cwd: root })
    }
  )
  if (!prepared.ok) {
    throw new Error(prepared.error)
  }
  expect(prepared.items[0].identity).toEqual({
    provider: 'legacy',
    agent: 'claude',
    sessionId: 'session',
    recordId: '#2'
  })
})
