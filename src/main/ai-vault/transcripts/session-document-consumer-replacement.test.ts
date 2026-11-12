import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readWholeTranscript } from './session-transcript-reader'
import { registerTranscriptConsumer } from './session-transcript-consumers'
import '../../ai-vault-search/storage/session-search-index-writer'
import '../../ai-vault-search/storage/session-search-index-test-fixture'

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
