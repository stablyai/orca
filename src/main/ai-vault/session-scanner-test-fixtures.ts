import { mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { initChatImportSchema } from '../chat-import/chat-import-schema'
import { upsertWebConversation, type WebChatSource } from '../chat-import/chat-import-store'
import SyncDatabase from '../sqlite/sync-database'
import {
  messageField as pbMessageField,
  stringField as pbStringField,
  varintField as pbVarintField
} from './protobuf-test-encoder'

export function isolatedScanRoots(root: string) {
  return {
    claudeProjectsDir: join(root, 'claude-projects'),
    codexSessionsDir: join(root, 'codex-sessions'),
    geminiSessionsDir: join(root, 'gemini-sessions'),
    // Why: keep the scanner off the real ~/.gemini/antigravity-cli/conversations
    // during tests, which would otherwise leak the developer's own sessions.
    antigravityConversationsDir: join(root, 'antigravity-conversations'),
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

// ---- Antigravity SQLite conversation fixtures ----
// Antigravity stores transcripts as protobuf blobs, so fixtures must be encoded
// the same way the CLI writes them, covering the few fields the scanner reads
// (step_type 14 user text at #19.#2, created Timestamp at #5.#1, workspace
// file:// URI in trajectory_metadata_blob). Field encoders are shared from
// protobuf-test-encoder.
export function writeAntigravityConversationDb(args: {
  dir: string
  conversationId: string
  workspaceUri: string
  userText: string
  unixSeconds: number
}): string {
  mkdirSync(args.dir, { recursive: true })
  const dbPath = join(args.dir, `${args.conversationId}.db`)
  const db = new SyncDatabase(dbPath)
  db.exec(
    `CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, step_payload blob, PRIMARY KEY (idx));
     CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id));`
  )
  const metaBlob = new Uint8Array(pbMessageField(3, pbStringField(12, args.workspaceUri)))
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', metaBlob)
  const userStep = new Uint8Array([
    ...pbVarintField(1, 14),
    ...pbVarintField(4, 3),
    ...pbMessageField(
      5,
      pbMessageField(1, [...pbVarintField(1, args.unixSeconds), ...pbVarintField(2, 0)])
    ),
    ...pbMessageField(19, pbStringField(2, args.userText))
  ])
  db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)').run(
    0,
    14,
    userStep
  )
  db.close()
  return dbPath
}
