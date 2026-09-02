import { basename, dirname, join } from 'node:path'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
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

export function resetCursorChatMetaIndexCacheForTests(): void {
  cursorChatMetaIndexCache.clear()
}

/** Path a discovery stat can watch so a rewritten meta.json invalidates the parse cache. */
export async function cursorChatMetaPath(transcriptPath: string): Promise<string | undefined> {
  const chatsRoot = cursorChatsRootFromTranscriptPath(transcriptPath)
  const chatId = cursorChatIdFromTranscriptPath(transcriptPath)
  if (!chatsRoot || !chatId) {
    return undefined
  }
  const index = await readCursorChatMetaIndex(chatsRoot)
  return index.get(chatId)
}

export async function readCursorChatMeta(transcriptPath: string): Promise<CursorChatMeta | null> {
  const metaPath = await cursorChatMetaPath(transcriptPath)
  if (!metaPath) {
    return null
  }
  const record = await readJsonObjectIfExists(metaPath)
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
  } catch {
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
    } catch {
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
