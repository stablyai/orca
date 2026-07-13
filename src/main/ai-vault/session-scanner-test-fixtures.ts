import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { initChatImportSchema } from '../chat-import/chat-import-schema'
import { upsertWebConversation, type WebChatSource } from '../chat-import/chat-import-store'
import SyncDatabase from '../sqlite/sync-database'

export function isolatedScanRoots(root: string) {
  return {
    claudeProjectsDir: join(root, 'claude-projects'),
    codexSessionsDir: join(root, 'codex-sessions'),
    geminiSessionsDir: join(root, 'gemini-sessions'),
    antigravityBrainDir: join(root, 'antigravity-brain'),
    copilotSessionsDir: join(root, 'copilot-sessions'),
    cursorProjectsDir: join(root, 'cursor-projects'),
    opencodeStorageDir: join(root, 'opencode-storage'),
    // Why: prevent the SQLite scanner from picking up the real
    // ~/.local/share/opencode/opencode.db during tests.
    opencodeDbPaths: [] as readonly string[],
    grokSessionsDir: join(root, 'grok-sessions'),
    devinTranscriptsDir: join(root, 'devin-transcripts'),
    hermesSessionsDir: join(root, 'hermes-sessions'),
    rovoSessionsDir: join(root, 'rovo-sessions'),
    openclawStateDir: join(root, 'openclaw-state'),
    openclawLegacyStateDir: join(root, 'openclaw-legacy-state'),
    piSessionsDir: join(root, 'pi-sessions'),
    ompSessionsDir: join(root, 'omp-sessions'),
    droidSessionsDir: join(root, 'droid-sessions'),
    droidProjectsDir: join(root, 'droid-projects'),
    kimiSessionsDir: join(root, 'kimi-sessions'),
    // Why: prevent the webchat scanner from picking up the real chat-import
    // chats.db (see opencodeDbPaths above for the same concern).
    webchatDbPath: join(root, 'webchat', 'chats.db')
  }
}

export function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

export async function writeJsonlFile(filePath: string, records: unknown[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, jsonLines(records))
}

export async function writeAntigravityTranscript(
  brainDir: string,
  sessionId: string,
  records: unknown[]
): Promise<string> {
  const transcriptPath = join(brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl')
  await writeJsonlFile(transcriptPath, records)
  return transcriptPath
}

export function writeAntigravityHistory(brainDir: string, records: unknown[]): Promise<void> {
  return writeJsonlFile(join(dirname(brainDir), 'history.jsonl'), records)
}

export function writeAntigravityScannerFixture(
  brainDir: string,
  sessionId: string
): Promise<string> {
  return writeAntigravityTranscript(brainDir, sessionId, [
    {
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-05-01T10:02:30.000Z',
      content: '<USER_REQUEST>Antigravity title</USER_REQUEST>'
    },
    {
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-05-01T10:02:31.000Z',
      content: 'Done'
    }
  ])
}

// [source, externalId, title] — createdAt/updatedAt are synthesized (index-ordered,
// 2026-05-01) since tests only assert presence/agent/title, not exact timestamps.
type WebChatConversationSeed = readonly [source: WebChatSource, externalId: string, title: string]

// Why: web chat sessions live in a chat-import SQLite DB, not on the
// filesystem, so tests that exercise scanAiVaultSessions need a DB seeder
// instead of writeJsonlFile.
export async function seedWebChatDb(
  dbPath: string,
  conversations: readonly WebChatConversationSeed[]
): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true })
  const db = new SyncDatabase(dbPath)
  initChatImportSchema(db)
  conversations.forEach(([source, externalId, title], index) => {
    const updatedAt = `2026-05-01T10:${String(10 + index).padStart(2, '0')}:01.000Z`
    upsertWebConversation(
      db,
      {
        source,
        externalId,
        title,
        createdAt: `2026-05-01T10:${String(10 + index).padStart(2, '0')}:00.000Z`,
        updatedAt,
        messages: [{ role: 'USER', idx: 0, text: title, createdAt: null }]
      },
      updatedAt
    )
  })
  db.close()
}
