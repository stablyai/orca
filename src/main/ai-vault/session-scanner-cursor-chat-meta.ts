import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, dirname, join } from 'node:path'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { timestampIso } from './session-scanner-accumulator'
import { extractString, normalizeTitleText, readJsonObjectIfExists } from './session-scanner-values'

// Cursor keeps a chat's transcript and its metadata in two unrelated trees:
// <cursor>/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl holds the
// messages, while <cursor>/chats/<md5 of cwd>/<uuid>/meta.json holds the cwd,
// title and timestamps. The md5 hashes the very cwd we are looking for, so the
// only way across is an index of the chat directories.

const CURSOR_CHATS_DIR = 'chats'
const CURSOR_CHAT_META_FILE = 'meta.json'
const CURSOR_TRANSCRIPTS_DIR = 'agent-transcripts'
const CURSOR_PROJECTS_DIR = 'projects'
// Why: custom and WSL Cursor homes can vary over a long-lived main process.
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
  cursorChatMetaIndexCache.clear()
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

/**
 * A refused WSL read is not "no chats", but it must not take the transcript
 * down with it: before this join a stalled distro could not hide a Cursor
 * session at all. Degrade to no metadata for the scan and report the root once.
 * The session still lists from its transcript alone, and the sidecar is
 * recorded as unknown, so the next healthy scan merges the real metadata in
 * without re-reading a byte of the transcript.
 */
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

async function readCursorChatMetaIndex(chatsRoot: string): Promise<Map<string, string>> {
  let workspaceDirs: string[]
  try {
    workspaceDirs = (await wslGatedReaddir(chatsRoot, 'scan'))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    // Why: a refused WSL read is not "no chats"; letting it through keeps the
    // session out of the parse cache instead of caching it without metadata.
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
  // Why: a rejected build (a refused WSL read) must not be served from the
  // cache forever; the next scan rebuilds while this one still sees the error.
  pending.catch(() => {
    if (cursorChatMetaIndexCache.get(chatsRoot) === pending) {
      cursorChatMetaIndexCache.delete(chatsRoot)
    }
  })
  return (await pending).metaPathByChatId
}

// Why: a new chat only bumps its own workspace directory, so the chats root's
// own mtime would keep serving an index that is missing the newest sessions.
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
      // Why: the same chat id never appears under two workspace hashes, so the
      // first hit wins and a duplicate would only cost a wasted read.
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
  // Why: a concurrent scan can replace this Promise while it resolves; only the
  // still-current entry may refresh recency without bypassing the cap.
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
