import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  addPreviewMessage,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import { pbFindString, pbMessage, pbPath, pbString, pbVarint } from './protobuf-wire-reader'
import { normalizeTitleText } from './session-scanner-values'
import SyncDatabase from '../sqlite/sync-database'
import { tableExists } from '../opencode-usage/schema-helpers'

// Antigravity (`agy`) stores each conversation as its own SQLite DB under
// ~/.gemini/antigravity-cli/conversations/<id>.db. Transcript turns live in the
// `steps` table as protobuf blobs: step_type 14 = a user message (text at
// #19.#2), step_type 15 = an assistant step whose natural-language text (when
// present, i.e. not a bare tool call) is at #20.#3. Each step carries a created
// Timestamp at #5.#1. The workspace path is a file:// URI in
// trajectory_metadata_blob. Only these few fields are decoded; everything else
// in the protobuf is ignored.
const ANTIGRAVITY_USER_STEP = 14
const ANTIGRAVITY_ASSISTANT_STEP = 15

type StepRow = { step_type: number; step_payload: unknown }

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  return null
}

function openReadonlyDatabase(dbPath: string): SyncDatabase {
  const db = new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
  // Why: belt-and-suspenders guard so a SELECT can never mutate the user's DB.
  db.pragma('query_only = ON')
  return db
}

// file:///Users/.../%E1%84... -> /Users/.../리뷰캐스트. Percent-decoded and
// NFC-normalized so the cwd matches Orca's (NFC) worktree paths for grouping,
// since Antigravity stores macOS paths in NFD.
function workspaceUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) {
    return null
  }
  const raw = uri.slice('file://'.length)
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // Keep the raw path if it isn't valid percent-encoding.
  }
  return decoded.normalize('NFC') || null
}

function readWorkspacePath(db: SyncDatabase): string | null {
  if (!tableExists(db, 'trajectory_metadata_blob')) {
    return null
  }
  const row = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get() as
    | { data: unknown }
    | undefined
  const bytes = toBytes(row?.data)
  if (!bytes) {
    return null
  }
  const uri = pbFindString(bytes, (text) => text.startsWith('file://'))
  return uri ? workspaceUriToPath(uri) : null
}

function stepMessageText(stepType: number, payload: Uint8Array): string | null {
  if (stepType === ANTIGRAVITY_USER_STEP) {
    const content = pbMessage(payload, 19)
    return content ? pbString(content, 2) : null
  }
  if (stepType === ANTIGRAVITY_ASSISTANT_STEP) {
    const content = pbMessage(payload, 20)
    return content ? pbString(content, 3) : null
  }
  return null
}

function stepTimestampMs(payload: Uint8Array): number | null {
  const timestamp = pbPath(payload, [5, 1])
  if (!timestamp) {
    return null
  }
  const seconds = pbVarint(timestamp, 1)
  if (seconds === null) {
    return null
  }
  const nanos = pbVarint(timestamp, 2) ?? 0
  return seconds * 1000 + Math.floor(nanos / 1_000_000)
}

/**
 * Parse a single Antigravity conversation DB into an `AiVaultSession`. Reads
 * the workspace path from `trajectory_metadata_blob` and folds the `steps`
 * table into a title (first user turn), preview messages, and a user+assistant
 * turn count. The database is opened read-only.
 * @returns The parsed session, or `null` if the file has no `steps` table.
 */
export async function parseAntigravitySqliteSession(args: {
  dbPath: string
  sessionId: string
  platform: NodeJS.Platform
  executionHostId?: ExecutionHostId
  executionHostPlatform?: NodeJS.Platform | null
}): Promise<AiVaultSession | null> {
  const { dbPath, sessionId, platform } = args
  let db: SyncDatabase | null = null
  try {
    db = openReadonlyDatabase(dbPath)
    if (!tableExists(db, 'steps')) {
      return null
    }

    const mtimeMs = statSync(dbPath).mtimeMs
    const accumulator = createAccumulator({
      agent: 'antigravity',
      file: { path: dbPath, mtimeMs, modifiedAt: new Date(mtimeMs).toISOString() },
      sessionId
    })
    const cwd = readWorkspacePath(db)
    accumulator.cwd = cwd
    accumulator.fallbackTitle = cwd ? basename(cwd) : null

    const rows = db
      .prepare('SELECT step_type, step_payload FROM steps ORDER BY idx ASC')
      .all() as StepRow[]
    for (const row of rows) {
      const payload = toBytes(row.step_payload)
      if (!payload) {
        continue
      }
      const timestamp = stepTimestampMs(payload)
      if (timestamp !== null) {
        updateTimeline(accumulator, timestamp)
      }
      const text = stepMessageText(row.step_type, payload)
      if (!text) {
        continue
      }
      const role = row.step_type === ANTIGRAVITY_USER_STEP ? 'user' : 'assistant'
      accumulator.messageCount += 1
      addPreviewMessage(accumulator, { role, text, timestamp: timestamp ?? undefined })
      if (role === 'user' && !accumulator.title) {
        accumulator.title = normalizeTitleText(text)
      }
    }

    return finalizeSession(accumulator, platform, {
      executionHostId: args.executionHostId,
      executionHostPlatform: args.executionHostPlatform
    })
  } finally {
    db?.close()
  }
}
