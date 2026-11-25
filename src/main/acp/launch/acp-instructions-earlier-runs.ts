import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeChatScratchFolderName } from '../../native-chat/conversation-files/native-chat-scratch-folder'
import {
  listProviderRelaysAtLaunch,
  providerRelayInventoryComplete
} from '../../provider-relay/app-provider-relays'
import { providerRelayChatsKeptThisRun } from '../../provider-relay/provider-relay-launch-inventory'

/** Removals run this many at a time, so a large leftover folder doesn't hold the launch long. */
const REMOVE_BATCH = 16
/** A launch writes its folder just before it spawns the agent. */
const SPAWN_SLACK_MS = 2_000
/** Per root, until its clear runs: chats this run wrote instructions for, by folder name. */
const launched = new Map<string, Set<string>>()
/** Per root: the clear in flight. */
const clearing = new Map<string, Promise<boolean>>()
/** Roots whose clear ran this run. */
const cleared = new Set<string>()

/**
 * Per-launch folders (`<chat>-<uuid>`) of each chat but its newest and, for a kept chat, the newest
 * written before its agent spawned: that agent reads it, even if a later launch (a conversation
 * copy that never ended) left a newer one.
 */
async function olderLaunches(
  root: string,
  names: string[],
  spawnedAt: ReadonlyMap<string, number>
): Promise<string[]> {
  const length = nativeChatScratchFolderName('').length
  const launches: { name: string; chat: string; at: number | null }[] = []
  for (const name of names.filter((entry) => entry.charAt(length) === '-')) {
    launches.push({ name, chat: name.slice(0, length), at: null })
  }
  for (let at = 0; at < launches.length; at += REMOVE_BATCH) {
    const batch = launches.slice(at, at + REMOVE_BATCH)
    await Promise.all(
      batch.map(async (launch) => {
        launch.at = (await lstat(join(root, launch.name)).catch(() => null))?.mtimeMs ?? null
      })
    )
  }
  const keep = new Map<string, { name: string; at: number }>()
  const pick = (key: string, name: string, at: number): void => {
    if ((keep.get(key)?.at ?? -1) < at) {
      keep.set(key, { name, at })
    }
  }
  for (const { name, chat, at } of launches) {
    if (at === null) {
      continue
    }
    pick(`newest:${chat}`, name, at)
    const spawned = spawnedAt.get(chat)
    if (spawned !== undefined && at <= spawned + SPAWN_SLACK_MS) {
      pick(`spawned:${chat}`, name, at)
    }
  }
  const kept = new Set([...keep.values()].map((launch) => launch.name))
  // One whose time can't be read may be the one an agent reads: it stays.
  return launches
    .filter((launch) => launch.at !== null && !kept.has(launch.name))
    .map((launch) => launch.name)
}

/** An earlier run's leftovers go, except those of chats whose agent the terminal host kept running
 *  (that agent still reads them) and of chats this run launched. One host holds a profile. */
async function clearEarlierRuns(root: string, remove: (path: string) => Promise<void>) {
  await listProviderRelaysAtLaunch()
  // A daemon that didn't answer may still run agents reading these; a later launch tries again.
  if (!providerRelayInventoryComplete()) {
    return false
  }
  // Every chat's folder name has the same length; its entries are it, `<it>.md` or `<it>-<uuid>`.
  const spawnedAt = new Map(
    [...providerRelayChatsKeptThisRun()].map(([chat, at]) => [
      nativeChatScratchFolderName(chat),
      at
    ])
  )
  const length = nativeChatScratchFolderName('').length
  // Read live: a launch that didn't wait for this names its chat before writing its folder.
  const keptBy = (name: string): boolean => {
    const chat = name.slice(0, length)
    return (
      (spawnedAt.has(chat) || launched.get(root)?.has(chat) === true) &&
      ['', '.', '-'].includes(name.charAt(length))
    )
  }
  const names = await readdir(root).catch(() => [])
  const older = new Set(await olderLaunches(root, names.filter(keptBy), spawnedAt))
  const gone = [...names.filter((name) => !keptBy(name)), ...older]
  for (let at = 0; at < gone.length; at += REMOVE_BATCH) {
    // Checked again per batch: a launch since names its chat before its first write.
    const batch = gone
      .slice(at, at + REMOVE_BATCH)
      .filter((name) => older.has(name) || !keptBy(name))
    await Promise.all(batch.map((name) => remove(join(root, name))))
  }
  return true
}

/** A launch never waits for the clear: it names its chat first, which keeps its folder. A clear
 *  skipped while a daemon was late is tried again by a later launch. Resolves when the clear ends. */
export function clearEarlierRunsOnce(
  root: string,
  sessionId: string,
  remove: (path: string) => Promise<void>
): Promise<void> {
  if (cleared.has(root)) {
    return Promise.resolve()
  }
  const names = launched.get(root) ?? new Set<string>()
  names.add(nativeChatScratchFolderName(sessionId))
  launched.set(root, names)
  let attempt = clearing.get(root)
  if (!attempt) {
    attempt = clearEarlierRuns(root, remove)
      .catch(() => false)
      .then((done) => {
        clearing.delete(root)
        if (done) {
          cleared.add(root)
          launched.delete(root)
        }
        return done
      })
    clearing.set(root, attempt)
  }
  return attempt.then(() => undefined)
}
