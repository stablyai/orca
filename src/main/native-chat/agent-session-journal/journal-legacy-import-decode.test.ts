import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decodeLegacyTranscriptImport } from './journal-legacy-import-decode'
import { validateAdoptedTranscriptSource } from './adopted-transcript-source'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-import-parse-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

it.each(['claude', 'codex'] as const)(
  'parses each %s source record once at N and 10N',
  async (agent) => {
    for (const count of [100, 1000]) {
      const filePath = join(root, `${agent}.jsonl`)
      const rows: Record<string, unknown>[] = Array.from({ length: count }, (_, index) =>
        agent === 'claude'
          ? {
              type: 'assistant',
              benchmark: 'parse-count',
              uuid: `row-${index}`,
              sessionId: 'session',
              cwd: root,
              message: { content: 'hello' }
            }
          : {
              type: 'response_item',
              benchmark: 'parse-count',
              payload: {
                type: 'message',
                role: 'assistant',
                id: `row-${index}`,
                content: [{ type: 'text', text: 'hello' }]
              }
            }
      )
      if (agent === 'codex') {
        rows.unshift({
          type: 'session_meta',
          benchmark: 'parse-count',
          payload: { id: 'session' }
        })
      }
      await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
      const parse = JSON.parse
      let parses = 0
      const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
        if (text.includes('"benchmark":"parse-count"')) {
          parses++
        }
        return parse(text, reviver)
      })
      const prepared = await decodeLegacyTranscriptImport(
        {
          agent,
          transcriptAgent: agent,
          filePath,
          sessionId: 'session',
          limits: { inlineHeadBytes: 16384 },
          validateSource: true
        },
        (observed) =>
          validateAdoptedTranscriptSource({
            agent,
            filePath,
            observed,
            source: { providerSessionId: 'session', workspaceCwd: root },
            maxSourceBytes: 16 * 1024 * 1024
          })
      )
      spy.mockRestore()
      // One JSONL value per row; Codex additionally discovers each physical segment's metadata once.
      expect(parses).toBe(agent === 'claude' ? count : count + 2)
      expect(prepared.ok && prepared.items.length).toBe(count)
      if (!prepared.ok) {
        throw new Error(prepared.error)
      }
      expect(prepared.items.at(-1)?.body).toEqual({
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'hello' }]
      })
    }
  }
)

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
