// Why (BUG 1, durable persistence): jcode chat conversations used to live only
// in renderer memory (chat-session-store.ts) and the backend kept no transcript,
// so conversations were lost on app restart, could not be listed, and a closed
// chat tab could not be reopened. This module is the on-disk backing store in
// the main process. It mirrors persistence.ts patterns: per-conversation JSON
// under <userData>/jcode-conversations/<sessionKey>.json, written atomically via
// a temp-file + rename so a crash mid-write never corrupts an existing record.
//
// The renderer remains the live layer (in-memory external store); it sends a
// snapshot on turn boundaries (start + done/error/stopped) which we persist, and
// reads back via list()/load() to rehydrate a (re)opened chat tab.
import { app } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type {
  JcodeConversationRecord,
  JcodeConversationSummary
} from '../../shared/jcode-chat-types'

// Why: cap transcript size so a very long conversation cannot grow its JSON file
// unboundedly. We keep the most recent N messages — older turns drop off. This
// bounds disk + load cost while preserving recent --resume continuity context.
const MAX_PERSISTED_MESSAGES = 2000

let conversationsDir: string | null = null

function getDir(): string {
  if (!conversationsDir) {
    conversationsDir = join(app.getPath('userData'), 'jcode-conversations')
  }
  if (!existsSync(conversationsDir)) {
    mkdirSync(conversationsDir, { recursive: true })
  }
  return conversationsDir
}

// Why: sessionKeys are renderer-generated UUIDs/tab ids, but defend against any
// path-traversal-shaped key reaching the filesystem by allowing only safe chars.
function isSafeKey(sessionKey: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(sessionKey) && sessionKey !== '.' && sessionKey !== '..'
}

function fileFor(sessionKey: string): string | null {
  if (!isSafeKey(sessionKey)) {
    return null
  }
  return join(getDir(), `${sessionKey}.json`)
}

function clampRecord(record: JcodeConversationRecord): JcodeConversationRecord {
  if (record.messages.length <= MAX_PERSISTED_MESSAGES) {
    return record
  }
  return {
    ...record,
    messages: record.messages.slice(record.messages.length - MAX_PERSISTED_MESSAGES)
  }
}

/** Persist (overwrite) a full conversation record atomically. Tolerates errors
 *  (logs + returns false) so a disk hiccup never breaks the live chat turn. */
export function saveConversation(record: JcodeConversationRecord): boolean {
  const file = fileFor(record.sessionKey)
  if (!file) {
    return false
  }
  const tmpFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    const toWrite = clampRecord({ ...record, updatedAt: record.updatedAt || Date.now() })
    writeFileSync(tmpFile, JSON.stringify(toWrite, null, 2), 'utf-8')
    renameSync(tmpFile, file)
    return true
  } catch (error) {
    // Why: best-effort — a failed snapshot must not break the conversation.
    console.error('[jcode-conversation-store] failed to save', record.sessionKey, error)
    try {
      if (existsSync(tmpFile)) {
        unlinkSync(tmpFile)
      }
    } catch {
      // ignore tmp cleanup failure
    }
    return false
  }
}

/** Load one conversation record, or null if missing/corrupt. */
export function loadConversation(sessionKey: string): JcodeConversationRecord | null {
  const file = fileFor(sessionKey)
  if (!file || !existsSync(file)) {
    return null
  }
  try {
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as JcodeConversationRecord
    if (typeof parsed?.sessionKey !== 'string' || !Array.isArray(parsed.messages)) {
      return null
    }
    return parsed
  } catch (error) {
    console.error('[jcode-conversation-store] failed to load', sessionKey, error)
    return null
  }
}

/** List conversation summaries (no transcript body), newest first. */
export function listConversations(): JcodeConversationSummary[] {
  let entries: string[]
  try {
    entries = readdirSync(getDir())
  } catch {
    return []
  }
  const summaries: JcodeConversationSummary[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) {
      continue
    }
    const record = loadConversation(name.slice(0, -'.json'.length))
    if (!record) {
      continue
    }
    summaries.push({
      sessionKey: record.sessionKey,
      worktreeId: record.worktreeId,
      cwd: record.cwd,
      title: record.title,
      updatedAt: record.updatedAt,
      resumeSessionId: record.resumeSessionId
    })
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  return summaries
}

/** Delete a conversation's on-disk record. Returns true if a file was removed. */
export function deleteConversation(sessionKey: string): boolean {
  const file = fileFor(sessionKey)
  if (!file || !existsSync(file)) {
    return false
  }
  try {
    unlinkSync(file)
    return true
  } catch (error) {
    console.error('[jcode-conversation-store] failed to delete', sessionKey, error)
    return false
  }
}
