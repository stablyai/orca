import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { subscribeNativeChatTranscript } from './transcript-watch'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createHermesStateDb(): { db: DatabaseSync; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-hermes-watch-'))
  tempRoots.push(root)
  const path = join(root, 'state.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp REAL
    )
  `)
  return { db, path }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('subscribeNativeChatTranscript Hermes state.db', () => {
  it('delivers the initial SQLite snapshot and rows appended after subscription', async () => {
    const { db, path } = createHermesStateDb()
    const snapshots: NativeChatMessage[][] = []
    const appends: NativeChatMessage[] = []
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(1, 'session-1', 'user', 'before', 1_787_000_000)

    let subscription: Awaited<ReturnType<typeof subscribeNativeChatTranscript>> | undefined
    try {
      subscription = await subscribeNativeChatTranscript({
        agent: 'hermes',
        sessionId: 'session-1',
        filePath: path,
        initialLimit: 300,
        onInitialSnapshot: (messages) => snapshots.push(messages),
        onAppend: (messages) => appends.push(...messages)
      })

      await waitFor(() => snapshots.length === 1)
      expect(snapshots[0]?.map((message) => message.blocks)).toEqual([
        [{ type: 'text', text: 'before' }]
      ])

      db.prepare(
        'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
      ).run(2, 'session-1', 'assistant', 'after', 1_787_000_001)

      await waitFor(() =>
        appends.some(
          (message) => message.blocks[0]?.type === 'text' && message.blocks[0].text === 'after'
        )
      )
    } finally {
      subscription?.unsubscribe()
      db.close()
    }
  })
})
