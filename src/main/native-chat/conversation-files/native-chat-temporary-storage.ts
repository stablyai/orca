// A chat's disposable build and test data: removed with the chat, or entry by entry once idle.
// Node builtins only: the reclaim script loads this file without a bundler.

import type { Dirent } from 'node:fs'
import { lstat, mkdir, opendir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

const ROOT_NAME = 'chat-temporary'
const CHAT_FOLDER_NAME = /^[0-9a-f]{32}$/
export const CHAT_TEMPORARY_RETENTION_MS = 7 * 24 * 60 * 60_000
const MAX_REMOVALS_PER_RUN = 200
const YIELD_EVERY = 128

export type ChatTemporaryEntry = {
  path: string
  reason: 'idle' | 'chat-removed' | 'recent' | 'unreadable'
}

export type ChatTemporaryOptions = {
  now?: number
  /** Folder names of retained chats; null means the roster cannot be trusted. */
  listHeld?: () => ReadonlySet<string> | null
  /** Kept between sweeps so a large entry in use is not walked again before it can expire. */
  recentUntil?: Map<string, number>
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function chatTemporaryRoot(stateDirectory: string): string {
  return join(stateDirectory, ROOT_NAME)
}

/** One folder per chat, stable across launches so a restarted agent keeps its environments. */
export async function prepareChatTemporaryFolder(
  stateDirectory: string,
  sessionKey: string
): Promise<string> {
  if (!CHAT_FOLDER_NAME.test(sessionKey)) {
    throw new Error('Invalid temporary storage session key')
  }
  const root = chatTemporaryRoot(stateDirectory)
  const folder = join(root, sessionKey)
  for (const path of [root, folder]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    if (!(await lstat(path)).isDirectory()) {
      throw new Error('Temporary storage must be a directory, not a symlink')
    }
  }
  return folder
}

async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    // Never list through a symlink: its target is not ours to age.
    return (await lstat(path)).isDirectory() ? await readdir(path, { withFileTypes: true }) : []
  } catch (error) {
    if (missing(error)) {
      return []
    }
    throw error
  }
}

/** The first change after the cutoff found in the tree; null when the whole tree is older. */
async function changeAfter(path: string, cutoff: number): Promise<number | null> {
  const pending = [path]
  let visited = 0
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (++visited % YIELD_EVERY === 0) {
      await setImmediate()
    }
    const info = await lstat(current)
    // Extracted archives keep old modification times; the change time records their arrival.
    const changed = Math.max(info.mtimeMs, info.ctimeMs)
    if (changed > cutoff) {
      return changed
    }
    if (info.isDirectory()) {
      for await (const entry of await opendir(current)) {
        pending.push(join(current, entry.name))
      }
    }
  }
  return null
}

async function entryReason(
  path: string,
  now: number,
  recentUntil: Map<string, number> | undefined
): Promise<ChatTemporaryEntry['reason']> {
  if ((recentUntil?.get(path) ?? 0) > now) {
    return 'recent'
  }
  try {
    const changed = await changeAfter(path, now - CHAT_TEMPORARY_RETENTION_MS)
    if (changed === null) {
      return 'idle'
    }
    recentUntil?.set(path, changed + CHAT_TEMPORARY_RETENTION_MS)
    return 'recent'
  } catch {
    return 'unreadable'
  }
}

async function* scanChatTemporaryStorage(
  stateDirectory: string,
  { now = Date.now(), listHeld, recentUntil }: ChatTemporaryOptions,
  isStopped: () => boolean
): AsyncGenerator<ChatTemporaryEntry> {
  const root = chatTemporaryRoot(stateDirectory)
  const chats = await listDirectory(root)
  // List folders first: each was created after its chat record, so the later roster includes it.
  const held = chats.length > 0 ? (listHeld?.() ?? null) : null
  const seen = new Set<string>()
  for (const chat of chats) {
    if (isStopped()) {
      return
    }
    // Dirents describe the entry itself, so a symlinked chat folder is never entered.
    if (!chat.isDirectory() || !CHAT_FOLDER_NAME.test(chat.name)) {
      continue
    }
    const folder = join(root, chat.name)
    if (held && !held.has(chat.name)) {
      yield { path: folder, reason: 'chat-removed' }
      continue
    }
    let entries: Dirent[]
    try {
      entries = await listDirectory(folder)
    } catch {
      yield { path: folder, reason: 'unreadable' }
      continue
    }
    for (const entry of entries) {
      if (isStopped()) {
        return
      }
      const path = join(folder, entry.name)
      seen.add(path)
      yield { path, reason: await entryReason(path, now, recentUntil) }
    }
  }
  for (const path of recentUntil?.keys() ?? []) {
    if (!seen.has(path)) {
      recentUntil?.delete(path)
    }
  }
}

/** What a sweep would do now, without removing anything. */
export async function inspectChatTemporaryStorage(
  stateDirectory: string,
  options: ChatTemporaryOptions = {},
  isStopped: () => boolean = () => false
): Promise<ChatTemporaryEntry[]> {
  const rows: ChatTemporaryEntry[] = []
  for await (const row of scanChatTemporaryStorage(stateDirectory, options, isStopped)) {
    rows.push(row)
  }
  return rows
}

/** Size, file count and Git data never protect an entry: this folder is disposable by contract. */
export async function sweepChatTemporaryStorage(
  stateDirectory: string,
  options: ChatTemporaryOptions = {},
  isStopped: () => boolean = () => false
): Promise<{ removed: number; failed: number }> {
  const result = { removed: 0, failed: 0 }
  for await (const entry of scanChatTemporaryStorage(stateDirectory, options, isStopped)) {
    if (result.removed + result.failed >= MAX_REMOVALS_PER_RUN) {
      break
    }
    if (entry.reason !== 'idle' && entry.reason !== 'chat-removed') {
      continue
    }
    try {
      // Removed as soon as it is judged, so a long scan cannot act on a stale verdict.
      await rm(entry.path, { recursive: true, force: true })
      result.removed += 1
    } catch {
      result.failed += 1
    }
  }
  return result
}
