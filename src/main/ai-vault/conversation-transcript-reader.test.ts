import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readConversationTranscript } from './conversation-transcript-reader'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function transcript(agent: 'claude' | 'codex' | 'cursor', texts: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'orca-conversation-'))
  roots.push(root)
  const sessionId = '12345678-1234-4234-8234-123456789abc'
  const filePath = join(root, `${sessionId}.jsonl`)
  const lines =
    agent === 'codex'
      ? [
          { type: 'session_meta', payload: { id: sessionId, cwd: root } },
          ...texts.map((text, index) => ({
            type: 'response_item',
            payload: {
              type: 'message',
              role: index % 2 ? 'assistant' : 'user',
              content: [{ type: index % 2 ? 'output_text' : 'input_text', text }]
            }
          }))
        ]
      : texts.map((text, index) =>
          agent === 'cursor'
            ? { role: index % 2 ? 'assistant' : 'user', content: text }
            : {
                type: index % 2 ? 'assistant' : 'user',
                sessionId,
                uuid: `message-${index}`,
                message: {
                  role: index % 2 ? 'assistant' : 'user',
                  content: [{ type: 'text', text }]
                }
              }
        )
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return {
    id: sessionId,
    source: { kind: 'transcript' as const, agent, sessionId, filePath },
    request: { reference: `orca-conversation://reference/${sessionId}?host=local` }
  }
}

describe('cross-agent source conversation reads', () => {
  it.each(['claude', 'codex', 'cursor'] as const)(
    'reads and searches %s original messages without an index',
    async (agent) => {
      const source = await transcript(agent, ['opening request', 'answer with TARGET', 'unrelated'])
      const result = await readConversationTranscript(source)
      expect(result.messages.map((message) => message.text)).toEqual([
        'opening request',
        'answer with TARGET',
        'unrelated'
      ])
      const found = await readConversationTranscript({
        ...source,
        request: { ...source.request, query: 'target' }
      })
      expect(found.messages.map((message) => message.text)).toEqual(['answer with TARGET'])
    }
  )

  it('reads a message larger than the list/index cap completely', async () => {
    const text = 'long message '.repeat(24000)
    const input = await transcript('cursor', [text])
    const output: string[] = []
    let cursor: string | undefined
    do {
      const page = await readConversationTranscript({
        ...input,
        request: { ...input.request, ...(cursor ? { cursor } : {}) }
      })
      output.push(...page.messages.map((message) => message.text))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(output.join('')).toBe(text)
  })

  it('refuses a source whose identity no longer matches', async () => {
    const input = await transcript('cursor', ['content'])
    await expect(
      readConversationTranscript({
        ...input,
        source: { ...input.source, sessionId: 'different-session' }
      })
    ).rejects.toThrow('no longer matches')
  })
})
