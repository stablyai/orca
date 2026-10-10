import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, dirname, join } from 'node:path'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { timestampIso } from './session-scanner-accumulator'
import {
  openCursorChatMetaIndex,
  resetCursorChatMetaIndexCacheForTests as resetCursorChatMetaIndexStoreForTests,
  type CursorChatMetaIndex
} from './session-scanner-cursor-chat-index'
import { extractString, normalizeTitleText, readJsonObjectIfExists } from './session-scanner-values'

// Cursor keeps a chat's transcript and its metadata in two unrelated trees:
// <cursor>/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl holds the
// messages, while <cursor>/chats/<md5 of cwd>/<uuid>/meta.json holds the cwd,
// title and timestamps. The md5 hashes the very cwd we are looking for, so the
// only way across is an index of the chat directories.

const CURSOR_CHATS_DIR = 'chats'
const CURSOR_TRANSCRIPTS_DIR = 'agent-transcripts'
const CURSOR_PROJECTS_DIR = 'projects'

export type CursorChatMeta = {
  title: string | null
  cwd: string | null
  createdAt: string | null
  updatedAt: string | null
}

type CursorChatMetaScan = {
  index: Map<string, Promise<CursorChatMetaIndex | null>>
  // Chats roots this scan could not read, reported once by the scan owner.
  refusals: Map<string, string>
  // Transcripts whose own meta.json read was refused, so the metadata merged
  // onto them is not what the file on disk says.
  refusedTranscripts: Set<string>
}

// Why: validating the module cache costs a readdir of the chats root plus a stat
// per workspace, and it cannot be skipped because the signature is built from
// those stats. Discovery asks once per transcript and finalize asks again, so
// the scope has to span both phases for one scan to see the tree once.
const scanScopedIndex = new AsyncLocalStorage<CursorChatMetaScan>()

export function resetCursorChatMetaIndexCacheForTests(): void {
  resetCursorChatMetaIndexStoreForTests()
}

/** Runs one whole scan, discovery and parse; every Cursor transcript in it shares one index read. */
export function withCursorChatMetaScan<T>(fn: () => Promise<T>): Promise<T> {
  return scanScopedIndex.run(
    { index: new Map(), refusals: new Map(), refusedTranscripts: new Set() },
    fn
  )
}

/**
 * True when this transcript's own meta.json read was refused, so the caller
 * records the sidecar as unknown rather than as the observation discovery made.
 * The transcript's own work and its resume point are kept either way.
 */
export function wasCursorChatMetaRefused(transcriptPath: string): boolean {
  return scanScopedIndex.getStore()?.refusedTranscripts.has(transcriptPath) ?? false
}

/** Chats roots the current scan was refused, for the caller to report as scan issues. */
export function cursorChatMetaRefusals(): { chatsRoot: string; message: string }[] {
  const scan = scanScopedIndex.getStore()
  return scan ? [...scan.refusals].map(([chatsRoot, message]) => ({ chatsRoot, message })) : []
}

/** Path a discovery stat can watch so a rewritten meta.json invalidates the parse cache. */
export async function cursorChatMetaPath(transcriptPath: string): Promise<string | undefined> {
  const chatsRoot = cursorChatsRootFromTranscriptPath(transcriptPath)
  const chatId = cursorChatIdFromTranscriptPath(transcriptPath)
  if (!chatsRoot || !chatId) {
    return undefined
  }
  const index = await readCursorChatMetaIndexOncePerScan(chatsRoot)
  if (!index) {
    return undefined
  }
  try {
    return await index.find(chatId)
  } catch (error) {
    if (!(error instanceof WslTranscriptFsError)) {
      throw error
    }
    recordCursorChatMetaRefusal(chatsRoot, error.message)
    return undefined
  }
}

function readCursorChatMetaIndexOncePerScan(
  chatsRoot: string
): Promise<CursorChatMetaIndex | null> {
  const open = (): Promise<CursorChatMetaIndex | null> =>
    openCursorChatMetaIndex(chatsRoot).catch((error: unknown) => {
      if (!(error instanceof WslTranscriptFsError)) {
        throw error
      }
      recordCursorChatMetaRefusal(chatsRoot, error.message)
      return null
    })
  const scan = scanScopedIndex.getStore()
  if (!scan) {
    return open()
  }
  let pending = scan.index.get(chatsRoot)
  if (!pending) {
    pending = open()
    scan.index.set(chatsRoot, pending)
  }
  return pending
}

function recordCursorChatMetaRefusal(chatsRoot: string, message: string): void {
  const scan = scanScopedIndex.getStore()
  if (scan && !scan.refusals.has(chatsRoot)) {
    scan.refusals.set(chatsRoot, message)
  }
}

export async function readCursorChatMeta(transcriptPath: string): Promise<CursorChatMeta | null> {
  const metaPath = await cursorChatMetaPath(transcriptPath)
  if (!metaPath) {
    return null
  }
  let record: Record<string, unknown> | null
  try {
    record = await readJsonObjectIfExists(metaPath)
  } catch (error) {
    if (!(error instanceof WslTranscriptFsError)) {
      throw error
    }
    // The session still lists, but unlike the index read this transcript's key
    // already includes meta.json's stat, so the caller must not cache the
    // un-enriched result. One issue per chats root, as for a refused index.
    recordCursorChatMetaRefusal(
      cursorChatsRootFromTranscriptPath(transcriptPath) ?? metaPath,
      error.message
    )
    scanScopedIndex.getStore()?.refusedTranscripts.add(transcriptPath)
    return null
  }
  if (!record) {
    return null
  }
  return {
    title: normalizeTitleText(extractString(record.title) ?? ''),
    cwd: extractString(record.cwd),
    createdAt: timestampIso(record.createdAtMs),
    updatedAt: timestampIso(record.updatedAtMs)
  }
}

function cursorChatIdFromTranscriptPath(transcriptPath: string): string | null {
  const chatDir = dirname(transcriptPath)
  return basename(dirname(chatDir)) === CURSOR_TRANSCRIPTS_DIR ? basename(chatDir) : null
}

function cursorChatsRootFromTranscriptPath(transcriptPath: string): string | null {
  let currentDir = dirname(transcriptPath)
  while (currentDir && dirname(currentDir) !== currentDir) {
    // The chats tree is a sibling of the projects tree, custom Cursor homes included.
    if (basename(currentDir) === CURSOR_PROJECTS_DIR) {
      return join(dirname(currentDir), CURSOR_CHATS_DIR)
    }
    currentDir = dirname(currentDir)
  }
  return null
}
