// A chat's disposable build and test data: removed with the chat, or entry by entry once idle.
// Node builtins only: the reclaim script loads this file without a bundler.

import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, mkdir, opendir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

const ROOT_NAME = 'chat-temporary'
const CHAT_FOLDER_NAME = /^[0-9a-f]{32}$/
// Holds the folder's own name: a folder without it was not made by Orca and is never removed.
const OWNER_MARKER = '.orca-owner'
const GIT_DIRECTORY = '.git'
const PARKED_PREFIX = '.orca-removing-'
export const CHAT_TEMPORARY_RETENTION_MS = 7 * 24 * 60 * 60_000
const MAX_REMOVALS_PER_RUN = 200
const YIELD_EVERY = 128

export type ChatTemporaryEntry = {
  path: string
  reason: 'idle' | 'chat-removed' | 'recent' | 'git' | 'unreadable'
}

export type ChatTemporaryOptions = {
  now?: number
  /** Folder names of retained chats; null means the roster cannot be trusted. */
  listHeld?: () => ReadonlySet<string> | null
  /** Kept between sweeps so a large entry found worth keeping is not walked again before its
   *  verdict can expire. */
  recentUntil?: Map<string, number>
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
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
  try {
    // Exclusive creation never writes through a symlink left in the marker's place.
    await writeFile(join(folder, OWNER_MARKER), sessionKey, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) {
      throw error
    }
  }
  return folder
}

async function ownedByOrca(folder: string, name: string): Promise<boolean> {
  const marker = join(folder, OWNER_MARKER)
  try {
    const info = await lstat(marker)
    // Read only a regular file of the expected size: never a FIFO, a symlink or a large file.
    return info.isFile() && info.size === name.length && (await readFile(marker, 'utf8')) === name
  } catch {
    return false
  }
}

async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    // Never list through a symlink: its target is not ours to age.
    return (await lstat(path)).isDirectory() ? await readdir(path, { withFileTypes: true }) : []
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return []
    }
    throw error
  }
}

/** What keeps a tree: the first change after the cutoff, or Git data; null when nothing does. */
async function keptBy(
  path: string,
  cutoff: number,
  parked = false
): Promise<number | 'git' | null> {
  const pending = [path]
  let visited = 0
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (++visited % YIELD_EVERY === 0) {
      await setImmediate()
    }
    const info = await lstat(current)
    // Extracted archives keep old modification times; the change time records their arrival.
    // Parking sets the moved entry's own change time, so there only its modification time counts.
    const changed = parked && current === path ? info.mtimeMs : Math.max(info.mtimeMs, info.ctimeMs)
    if (changed > cutoff) {
      return changed
    }
    if (info.isDirectory()) {
      for await (const entry of await opendir(current)) {
        // A checkout can hold the only copy of uncommitted or unpushed work.
        if (entry.name === GIT_DIRECTORY) {
          return 'git'
        }
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
    const kept = await keptBy(path, now - CHAT_TEMPORARY_RETENTION_MS)
    if (kept === null) {
      return 'idle'
    }
    // Git data is checked again after a retention period, in case the checkout was deleted.
    recentUntil?.set(path, (kept === 'git' ? now : kept) + CHAT_TEMPORARY_RETENTION_MS)
    return kept === 'git' ? 'git' : 'recent'
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
    if (!(await ownedByOrca(folder, chat.name))) {
      continue
    }
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
    // A checkout made in the folder itself owns every entry beside it.
    const checkout = entries.some((entry) => entry.name === GIT_DIRECTORY)
    for (const entry of entries) {
      if (isStopped()) {
        return
      }
      if (entry.name === OWNER_MARKER) {
        continue
      }
      const path = join(folder, entry.name)
      seen.add(path)
      yield { path, reason: checkout ? 'git' : await entryReason(path, now, recentUntil) }
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

/** Moves an idle entry out of reach of new writes, then keeps it if the scan missed a change. */
async function parkIfStillIdle(path: string, cutoff: number): Promise<string | null> {
  const parked = join(dirname(path), `${PARKED_PREFIX}${randomUUID()}`)
  // An entry that cannot be moved, such as one in use on Windows, is kept.
  await rename(path, parked)
  const kept = await keptBy(parked, cutoff, true).catch(() => 'unreadable')
  if (kept === null) {
    return parked
  }
  // A failed restore leaves the data parked, where it ages like any other entry.
  await rename(parked, path).catch(() => undefined)
  return null
}

/** Git data keeps an entry; size and file count never do: this folder is disposable by contract. */
export async function sweepChatTemporaryStorage(
  stateDirectory: string,
  options: ChatTemporaryOptions = {},
  isStopped: () => boolean = () => false
): Promise<{ removed: number; failed: number }> {
  const result = { removed: 0, failed: 0 }
  const now = options.now ?? Date.now()
  const scan = scanChatTemporaryStorage(stateDirectory, { ...options, now }, isStopped)
  for await (const entry of scan) {
    if (result.removed + result.failed >= MAX_REMOVALS_PER_RUN) {
      break
    }
    if (entry.reason !== 'idle' && entry.reason !== 'chat-removed') {
      continue
    }
    try {
      const target =
        entry.reason === 'idle'
          ? await parkIfStillIdle(entry.path, now - CHAT_TEMPORARY_RETENTION_MS)
          : entry.path
      if (target !== null) {
        await rm(target, { recursive: true, force: true })
        result.removed += 1
      }
    } catch {
      result.failed += 1
    }
  }
  return result
}
