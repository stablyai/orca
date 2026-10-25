import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readWholeTranscript } from './session-transcript-reader'
import { registerTranscriptConsumer } from './session-transcript-consumers'
import { SessionSearchIndexWriter } from '../ai-vault-search/session-search-index-writer'
import { openSessionSearchIndexFile } from '../ai-vault-search/session-search-index-test-fixture'

it.each(['hermes', 'gemini', 'devin', 'cline'] as const)(
  'indexes only the final %s message array, preserving JSON last-field semantics',
  async (agent) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-document-replacement-'))
    const index = await openSessionSearchIndexFile('ss-document-replacement')
    const writer = new SessionSearchIndexWriter(index.db, 1)
    const unregister = registerTranscriptConsumer({
      beginRead: (start) => {
        const write = writer.beginWrite(start.candidate, start.mode, start.previousByteOffset)
        if (!write) {
          throw new Error('Expected write')
        }
        return {
          message: (message) => write.add(message),
          finish: (outcome) => {
            if (outcome.incomplete) {
              write.discard()
            } else {
              write.commit(outcome)
            }
          }
        }
      }
    })
    try {
      const path = join(root, 'session.json')
      const key = agent === 'devin' ? 'steps' : 'messages'
      const message = (text: string) =>
        JSON.stringify({
          role: 'assistant',
          type: 'gemini',
          source: 'agent',
          content: text,
          message: text
        })
      const content = `{"${key}":[${message('overwritten')}],"${key}":[${message('retained 😀')}],"session_id":"session"}`
      await writeFile(path, agent === 'cline' ? '{"session_id":"session"}' : content)
      if (agent === 'cline') {
        await writeFile(join(root, 'session.messages.json'), content)
      }
      const fileStat = await stat(path)
      const session = await readWholeTranscript({
        candidate: {
          agent,
          codexHome: null,
          file: {
            path,
            mtimeMs: 1,
            modifiedAt: new Date(1).toISOString(),
            sizeBytes: fileStat.size
          }
        },
        platform: 'linux'
      })
      expect(session?.messageCount).toBe(1)
      expect(index.db.prepare('SELECT assistant_text FROM messages_fts').all()).toEqual([
        { assistant_text: 'retained 😀' }
      ])
    } finally {
      unregister()
      writer.close()
      await index.close()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('discards partially emitted messages from a malformed Cline sidecar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-cline-incomplete-'))
  const published: string[] = []
  const unregister = registerTranscriptConsumer({
    beginRead: () => {
      const pending: string[] = []
      return {
        message: (message) => pending.push(message.text),
        finish: (outcome) => {
          if (!outcome.incomplete) {
            published.push(...pending)
          }
        }
      }
    }
  })
  try {
    const path = join(root, 'session.json')
    await writeFile(path, '{"session_id":"session"}')
    await writeFile(
      join(root, 'session.messages.json'),
      '{"messages":[{"role":"assistant","content":"incomplete"}],'
    )
    const session = await readWholeTranscript({
      candidate: {
        agent: 'cline',
        codexHome: null,
        file: { path, mtimeMs: 1, modifiedAt: new Date(1).toISOString() }
      },
      platform: 'linux'
    })
    expect(session?.messageCount).toBe(0)
    expect(published).toEqual([])
  } finally {
    unregister()
    await rm(root, { recursive: true, force: true })
  }
})
