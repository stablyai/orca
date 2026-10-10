import { join } from 'node:path'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'

const CURSOR_CHAT_META_FILE = 'meta.json'
const CURSOR_CHAT_META_INDEX_CACHE_MAX = 8

type RankedWorkspace = {
  name: string
  mtimeMs: number | null
}

type CursorChatMetaIndexEntry = {
  signature: string
  metaPathByChatId: Map<string, string>
  // Workspace buckets not listed yet, newest directory mtime first.
  pendingWorkspaces: string[]
  walk: Promise<void>
}

const cursorChatMetaIndexCache = new Map<string, CursorChatMetaIndexEntry>()

export function resetCursorChatMetaIndexCacheForTests(): void {
  cursorChatMetaIndexCache.clear()
}

export type CursorChatMetaIndex = {
  find(chatId: string): Promise<string | undefined>
}

export async function openCursorChatMetaIndex(chatsRoot: string): Promise<CursorChatMetaIndex> {
  const workspaceNames = await readWorkspaceNames(chatsRoot)
  if (!workspaceNames) {
    return { find: async () => undefined }
  }
  const ranked = await rankWorkspaces(chatsRoot, workspaceNames)
  const signature = workspaceSignature(ranked)
  let entry = cursorChatMetaIndexCache.get(chatsRoot)
  if (!entry || entry.signature !== signature) {
    entry = {
      signature,
      metaPathByChatId: new Map(),
      pendingWorkspaces: workspacesNewestFirst(ranked),
      walk: Promise.resolve()
    }
    storeCursorChatMetaIndexEntry(chatsRoot, entry)
  } else {
    cursorChatMetaIndexCache.delete(chatsRoot)
    cursorChatMetaIndexCache.set(chatsRoot, entry)
  }
  const current = entry
  return {
    find: (chatId) => findCursorChatMeta(chatsRoot, current, chatId)
  }
}

async function readWorkspaceNames(chatsRoot: string): Promise<string[] | null> {
  try {
    return (await wslGatedReaddir(chatsRoot, 'scan'))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return null
  }
}

async function rankWorkspaces(
  chatsRoot: string,
  workspaceNames: string[]
): Promise<RankedWorkspace[]> {
  return Promise.all(
    workspaceNames.map(async (name) => {
      try {
        const dirStat = await wslGatedStat(join(chatsRoot, name), 'scan')
        return { name, mtimeMs: dirStat.mtimeMs }
      } catch {
        return { name, mtimeMs: null }
      }
    })
  )
}

function workspaceSignature(ranked: RankedWorkspace[]): string {
  const mtimeByName = new Map(ranked.map((workspace) => [workspace.name, workspace.mtimeMs]))
  return [...mtimeByName.keys()]
    .sort()
    .map((name) => `${name}:${mtimeByName.get(name) ?? '?'}`)
    .join('|')
}

function workspacesNewestFirst(ranked: RankedWorkspace[]): string[] {
  return ranked
    .slice()
    .sort((left, right) => {
      const leftTime = left.mtimeMs ?? Number.NEGATIVE_INFINITY
      const rightTime = right.mtimeMs ?? Number.NEGATIVE_INFINITY
      if (leftTime !== rightTime) {
        return rightTime - leftTime
      }
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    })
    .map((workspace) => workspace.name)
}

function findCursorChatMeta(
  chatsRoot: string,
  entry: CursorChatMetaIndexEntry,
  chatId: string
): Promise<string | undefined> {
  const run = entry.walk.then(async () => {
    while (!entry.metaPathByChatId.has(chatId) && entry.pendingWorkspaces.length > 0) {
      const workspace = entry.pendingWorkspaces[0]
      if (workspace === undefined) {
        break
      }
      await indexWorkspace(chatsRoot, workspace, entry.metaPathByChatId)
      entry.pendingWorkspaces.shift()
    }
  })
  // Why: the caller already observes `run`. Rethrowing here would be a second, unhandled rejection.
  entry.walk = run.then(
    () => undefined,
    () => {
      if (cursorChatMetaIndexCache.get(chatsRoot) === entry) {
        cursorChatMetaIndexCache.delete(chatsRoot)
      }
    }
  )
  return run.then(() => entry.metaPathByChatId.get(chatId))
}

async function indexWorkspace(
  chatsRoot: string,
  workspace: string,
  metaPathByChatId: Map<string, string>
): Promise<void> {
  let chatDirs
  try {
    chatDirs = await wslGatedReaddir(join(chatsRoot, workspace), 'scan')
  } catch (error) {
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return
  }
  for (const chatDir of chatDirs) {
    if (chatDir.isDirectory() && !metaPathByChatId.has(chatDir.name)) {
      metaPathByChatId.set(
        chatDir.name,
        join(chatsRoot, workspace, chatDir.name, CURSOR_CHAT_META_FILE)
      )
    }
  }
}

function storeCursorChatMetaIndexEntry(chatsRoot: string, entry: CursorChatMetaIndexEntry): void {
  cursorChatMetaIndexCache.delete(chatsRoot)
  cursorChatMetaIndexCache.set(chatsRoot, entry)
  if (cursorChatMetaIndexCache.size > CURSOR_CHAT_META_INDEX_CACHE_MAX) {
    const oldest = cursorChatMetaIndexCache.keys().next()
    if (!oldest.done) {
      cursorChatMetaIndexCache.delete(oldest.value)
    }
  }
}
