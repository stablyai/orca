import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, dirname, join } from 'node:path'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { timestampIso } from './session-scanner-accumulator'
import { extractString, normalizeTitleText, readJsonObjectIfExists } from './session-scanner-values'

// Transcript paths cannot derive hashed metadata buckets; index the separate chats tree by chat ID.

const CURSOR_CHATS_DIR = 'chats'
const CURSOR_CHAT_META_FILE = 'meta.json'
const CURSOR_TRANSCRIPTS_DIR = 'agent-transcripts'
const CURSOR_PROJECTS_DIR = 'projects'
// Bound retained indexes as custom and WSL homes change.
const CURSOR_CHAT_META_INDEX_CACHE_MAX = 8

export type CursorChatMeta = {
  title: string | null
  cwd: string | null
  createdAt: string | null
  updatedAt: string | null
}

type CursorChatMetaIndexEntry = {
  signature: string
  metaPathByChatId: Map<string, string>
}

const cursorChatMetaIndexCache = new Map<string, Promise<CursorChatMetaIndexEntry>>()

type CursorChatMetaScan = {
  index: Map<string, Promise<Map<string, string>>>
  // Chats roots this scan could not read, reported once by the scan owner.
  refusals: Map<string, string>
  // Refused metadata reads must remain unknown rather than validate cached enrichment.
  refusedTranscripts: Set<string>
}

// Share index validation across discovery and parsing to avoid repeated directory reads and workspace stats.
const scanScopedIndex = new AsyncLocalStorage<CursorChatMetaScan>()

export function resetCursorChatMetaIndexCacheForTests(): void {
  cursorChatMetaIndexCache.clear()
}

export function withCursorChatMetaScan<T>(fn: () => Promise<T>): Promise<T> {
  return scanScopedIndex.run(
    { index: new Map(), refusals: new Map(), refusedTranscripts: new Set() },
    fn
  )
}

/** Mark refused metadata unknown while retaining the transcript fold and resume point. */
export function wasCursorChatMetaRefused(transcriptPath: string): boolean {
  return scanScopedIndex.getStore()?.refusedTranscripts.has(transcriptPath) ?? false
}

/** Whether this scan could not look for the transcript's meta.json, so its absence proves nothing. */
export function cursorChatMetaUnavailable(transcriptPath: string): boolean {
  const chatsRoot = cursorChatsRootFromTranscriptPath(transcriptPath)
  return (
    wasCursorChatMetaRefused(transcriptPath) ||
    (chatsRoot !== null && scanScopedIndex.getStore()?.refusals.has(chatsRoot) === true)
  )
}

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
  return index.get(chatId)
}

function readCursorChatMetaIndexOncePerScan(chatsRoot: string): Promise<Map<string, string>> {
  const scan = scanScopedIndex.getStore()
  if (!scan) {
    return readCursorChatMetaIndexOrNone(chatsRoot)
  }
  let pending = scan.index.get(chatsRoot)
  if (!pending) {
    pending = readCursorChatMetaIndexOrNone(chatsRoot)
    scan.index.set(chatsRoot, pending)
  }
  return pending
}

/** Keep transcripts listed on WSL refusal, report the root once, and leave metadata unknown for retry. */
async function readCursorChatMetaIndexOrNone(chatsRoot: string): Promise<Map<string, string>> {
  try {
    return await readCursorChatMetaIndex(chatsRoot)
  } catch (error) {
    if (!(error instanceof WslTranscriptFsError)) {
      throw error
    }
    recordCursorChatMetaRefusal(chatsRoot, error.message)
    return new Map()
  }
}

function recordCursorChatMetaRefusal(chatsRoot: string, message: string): void {
  const scan = scanScopedIndex.getStore()
  if (scan && !scan.refusals.has(chatsRoot)) {
    scan.refusals.set(chatsRoot, message)
  }
}

export async function readCursorChatMeta(
  transcriptPath: string,
  signal?: AbortSignal
): Promise<CursorChatMeta | null> {
  const metaPath = await cursorChatMetaPath(transcriptPath)
  if (!metaPath) {
    return null
  }
  let record: Record<string, unknown> | null
  try {
    record = await readJsonObjectIfExists(metaPath, signal)
  } catch (error) {
    if (!(error instanceof WslTranscriptFsError)) {
      throw error
    }
    // Discovery observed this sidecar; mark its refused read unknown instead of validating un-enriched results.
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

async function readCursorChatMetaIndex(chatsRoot: string): Promise<Map<string, string>> {
  let workspaceDirs: string[]
  try {
    workspaceDirs = (await wslGatedReaddir(chatsRoot, 'scan'))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    // Propagate WSL refusal so the scan records unknown metadata and can retry enrichment.
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return new Map()
  }
  const signature = await readCursorChatsSignature(chatsRoot, workspaceDirs)
  const cached = await readCachedCursorChatMetaIndex(chatsRoot, signature)
  if (cached) {
    return cached
  }
  const pending = buildCursorChatMetaIndex(chatsRoot, workspaceDirs).then((metaPathByChatId) => ({
    signature,
    metaPathByChatId
  }))
  storeCursorChatMetaIndexEntry(chatsRoot, pending)
  // Evict rejected builds so the next scan retries instead of reusing a refused WSL read.
  pending.catch(() => {
    if (cursorChatMetaIndexCache.get(chatsRoot) === pending) {
      cursorChatMetaIndexCache.delete(chatsRoot)
    }
  })
  return (await pending).metaPathByChatId
}

// New chats update their workspace directory; the chats root mtime alone misses them.
async function readCursorChatsSignature(
  chatsRoot: string,
  workspaceDirs: string[]
): Promise<string> {
  const parts = await Promise.all(
    workspaceDirs.map(async (name) => {
      try {
        const dirStat = await wslGatedStat(join(chatsRoot, name), 'scan')
        return `${name}:${dirStat.mtimeMs}`
      } catch {
        return `${name}:?`
      }
    })
  )
  return parts.join('|')
}

async function buildCursorChatMetaIndex(
  chatsRoot: string,
  workspaceDirs: string[]
): Promise<Map<string, string>> {
  const metaPathByChatId = new Map<string, string>()
  for (const workspaceDir of workspaceDirs) {
    let chatDirs
    try {
      chatDirs = await wslGatedReaddir(join(chatsRoot, workspaceDir), 'scan')
    } catch (error) {
      if (error instanceof WslTranscriptFsError) {
        throw error
      }
      continue
    }
    for (const chatDir of chatDirs) {
      if (chatDir.isDirectory() && !metaPathByChatId.has(chatDir.name)) {
        metaPathByChatId.set(
          chatDir.name,
          join(chatsRoot, workspaceDir, chatDir.name, CURSOR_CHAT_META_FILE)
        )
      }
    }
  }
  return metaPathByChatId
}

async function readCachedCursorChatMetaIndex(
  chatsRoot: string,
  signature: string
): Promise<Map<string, string> | undefined> {
  const cached = cursorChatMetaIndexCache.get(chatsRoot)
  if (!cached) {
    return undefined
  }
  const entry = await cached
  if (entry.signature !== signature) {
    return undefined
  }
  // Refresh only the current promise; resurrecting evicted entries would bypass the cap.
  if (cursorChatMetaIndexCache.get(chatsRoot) === cached) {
    cursorChatMetaIndexCache.delete(chatsRoot)
    cursorChatMetaIndexCache.set(chatsRoot, cached)
  }
  return entry.metaPathByChatId
}

function storeCursorChatMetaIndexEntry(
  chatsRoot: string,
  pending: Promise<CursorChatMetaIndexEntry>
): void {
  cursorChatMetaIndexCache.delete(chatsRoot)
  cursorChatMetaIndexCache.set(chatsRoot, pending)
  if (cursorChatMetaIndexCache.size > CURSOR_CHAT_META_INDEX_CACHE_MAX) {
    const oldest = cursorChatMetaIndexCache.keys().next()
    if (!oldest.done) {
      cursorChatMetaIndexCache.delete(oldest.value)
    }
  }
}
