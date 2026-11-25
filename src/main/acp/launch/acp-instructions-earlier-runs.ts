import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeChatScratchFolderName } from '../../native-chat/conversation-files/native-chat-scratch-folder'
import { listProviderRelaysAtLaunch } from '../../provider-relay/app-provider-relays'
import {
  keptProviderRelaysComplete,
  providerRelayChatsKeptThisRun
} from '../../provider-relay/provider-relay-launch-inventory'

/** Removals run this many at a time, so a large leftover folder doesn't hold the launch long. */
const REMOVE_BATCH = 16
/** A launch writes its folder just before it spawns the agent. */
const SPAWN_SLACK_MS = 2_000
/** Per root, until its clear runs: chats this run wrote instructions for, by folder name. */
const launched = new Map<string, Set<string>>()
/** Per root: whether its clear ran, or the attempt in flight. */
const cleared = new Map<string, Promise<boolean>>()

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
  const launches: { name: string; chat: string; at: number }[] = []
  for (const name of names.filter((entry) => entry.charAt(length) === '-')) {
    launches.push({ name, chat: name.slice(0, length), at: 0 })
  }
  for (let at = 0; at < launches.length; at += REMOVE_BATCH) {
    const batch = launches.slice(at, at + REMOVE_BATCH)
    await Promise.all(
      batch.map(async (launch) => {
        launch.at = (await lstat(join(root, launch.name)).catch(() => null))?.mtimeMs ?? 0
      })
    )
  }
  const keep = new Map<string, string>()
  const pick = (key: string, launch: { name: string; at: number }): void => {
    const held = launches.find((other) => other.name === keep.get(key))
    if (!held || held.at < launch.at) {
      keep.set(key, launch.name)
    }
  }
  for (const launch of launches) {
    pick(`newest:${launch.chat}`, launch)
    const spawned = spawnedAt.get(launch.chat)
    if (spawned !== undefined && launch.at <= spawned + SPAWN_SLACK_MS) {
      pick(`spawned:${launch.chat}`, launch)
    }
  }
  const kept = new Set(keep.values())
  return launches.filter((launch) => !kept.has(launch.name)).map((launch) => launch.name)
}

/** An earlier run's leftovers go, except those of chats whose agent the terminal host kept running
 *  (that agent still reads them) and of chats this run launched. One host holds a profile. */
async function clearEarlierRuns(root: string, remove: (path: string) => Promise<void>) {
  await listProviderRelaysAtLaunch()
  // A daemon that didn't answer may still run agents reading these; a later launch tries again.
  if (!keptProviderRelaysComplete()) {
    return false
  }
  // Every chat's folder name has the same length; its entries are it, `<it>.md` or `<it>-<uuid>`.
  const spawnedAt = new Map(
    [...providerRelayChatsKeptThisRun()].map(([chat, at]) => [
      nativeChatScratchFolderName(chat),
      at
    ])
  )
  const kept = new Set([...spawnedAt.keys(), ...(launched.get(root) ?? [])])
  const length = nativeChatScratchFolderName('').length
  const keptBy = (name: string): boolean =>
    kept.has(name.slice(0, length)) && ['', '.', '-'].includes(name.charAt(length))
  const names = await readdir(root).catch(() => [])
  const gone = [
    ...names.filter((name) => !keptBy(name)),
    ...(await olderLaunches(root, names.filter(keptBy), spawnedAt))
  ]
  for (let at = 0; at < gone.length; at += REMOVE_BATCH) {
    await Promise.all(gone.slice(at, at + REMOVE_BATCH).map((name) => remove(join(root, name))))
  }
  launched.delete(root)
  return true
}

/** The first launch in a run waits for the clear; one skipped while a daemon was late is tried
 *  again behind later launches, which don't wait for it. */
export async function clearEarlierRunsOnce(
  root: string,
  sessionId: string,
  remove: (path: string) => Promise<void>
): Promise<void> {
  const attempt = cleared.get(root)
  if (attempt === undefined || !(await attempt)) {
    // Only a clear still to come needs to know this run's chats.
    const names = launched.get(root) ?? new Set<string>()
    names.add(nativeChatScratchFolderName(sessionId))
    launched.set(root, names)
  }
  if (!attempt) {
    const first = clearEarlierRuns(root, remove).catch(() => false)
    cleared.set(root, first)
    await first
    return
  }
  if (!(await attempt) && cleared.get(root) === attempt) {
    cleared.set(
      root,
      clearEarlierRuns(root, remove).catch(() => false)
    )
  }
}
