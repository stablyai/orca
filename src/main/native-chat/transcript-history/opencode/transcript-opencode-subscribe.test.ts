import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatTranscriptPage } from '../../../../shared/native-chat/transcript/streaming/native-chat-transcript-frames'
import type { OpenCodeTranscriptDeps } from './transcript-opencode'
import {
  readOpenCode2TranscriptPage,
  readOpenCode2TranscriptSignal
} from './transcript-opencode2-sqlite'
import { subscribeOpenCodeNativeChatTranscript } from './transcript-opencode-subscribe'

afterEach(() => vi.useRealTimers())

it('recovers a transcript gap with a pageable replacement and continues appending', async () => {
  vi.useFakeTimers()
  const db = new Database(':memory:')
  let subscription: ReturnType<typeof subscribeOpenCodeNativeChatTranscript> | undefined
  try {
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
        seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      INSERT INTO session_v2 VALUES ('session');
    `)
    const insert = (sequence: number) =>
      db
        .prepare("INSERT INTO session_message VALUES (?, 'session', 'user', ?, ?, ?, ?)")
        .run(
          `msg-${sequence}`,
          sequence,
          sequence,
          sequence,
          JSON.stringify({ text: `message ${sequence}` })
        )
    const deps: OpenCodeTranscriptDeps = {
      resolveDbPath: async () => ':memory:',
      readSignal: async (_path, sessionId) => readOpenCode2TranscriptSignal(db, sessionId),
      readPage: async (args) => readOpenCode2TranscriptPage(db, args)
    }
    const snapshots: NativeChatMessage[] = []
    const replacements: NativeChatTranscriptPage[] = []
    const appended: NativeChatMessage[] = []
    insert(1)
    subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'session',
        resolvePollIntervalMs: 1,
        onInitialSnapshot: (messages) => snapshots.push(...messages),
        onReplace: (messages, hasMore, beforeOffset) =>
          replacements.push({ messages, hasMore, beforeOffset }),
        onAppend: (messages) => appended.push(...messages)
      },
      undefined,
      deps
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshots.map((message) => message.id)).toEqual(['opencode:msg-1'])

    for (let sequence = 2; sequence <= 2501; sequence++) {
      insert(sequence)
    }
    await vi.advanceTimersByTimeAsync(3)
    const replacement = replacements.at(-1)
    expect(replacement).toMatchObject({ hasMore: true, beforeOffset: 102 })
    expect(replacement?.messages[0]).toMatchObject({
      id: 'opencode:msg-102',
      transcriptOffset: 102
    })
    expect(replacement?.messages.at(-1)).toMatchObject({
      id: 'opencode:msg-2501',
      transcriptOffset: 2501
    })

    insert(2502)
    await vi.advanceTimersByTimeAsync(1)
    expect(appended).toMatchObject([
      { id: 'opencode:msg-2502', blocks: [{ type: 'text', text: 'message 2502' }] }
    ])
  } finally {
    subscription?.unsubscribe()
    db.close()
  }
})
