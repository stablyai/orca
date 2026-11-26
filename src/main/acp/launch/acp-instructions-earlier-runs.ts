import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeChatScratchFolderName } from '../../native-chat/conversation-files/native-chat-scratch-folder'
import { providerRelayRunLiveness } from '../../provider-relay/app-provider-relays'
import { providerRelayRoute } from '../../provider-relay/provider-relay-route'
import { peekOpenedAgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store-slot'
import { agentSessionRunPlacement } from '../../../shared/agent-session/lifecycle/agent-session-run-placement'

/** Removals run this many at a time, so a large leftover folder doesn't hold the launch long. */
const REMOVE_BATCH = 16
/** Per root, until its clear runs: chats this run wrote instructions for, by folder name. */
const launched = new Map<string, Set<string>>()
/** Per root: the clear in flight. */
const clearing = new Map<string, Promise<boolean>>()
/** Roots whose clear ran this run. */
const cleared = new Set<string>()

/** Per-launch folders (`<chat>-<uuid>`) of each of `names`' chats but its newest. */
async function olderLaunches(root: string, names: string[]): Promise<string[]> {
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
  const newest = new Map<string, { name: string; at: number }>()
  for (const { name, chat, at } of launches) {
    if (at !== null && (newest.get(chat)?.at ?? -1) < at) {
      newest.set(chat, { name, at })
    }
  }
  const kept = new Set([...newest.values()].map((launch) => launch.name))
  // One whose time can't be read may be the one an agent reads: it stays.
  return launches
    .filter((launch) => launch.at !== null && !kept.has(launch.name))
    .map((launch) => launch.name)
}

/**
 * Chats (by folder name, among `present`) whose last run went to a terminal host and isn't proven
 * gone: their agent may still read any of their folders. Only the run's own daemon start decides,
 * asked without touching the chat's recovery state; with no relay route here, none can say.
 */
async function liveRelayedChats(present: ReadonlySet<string>): Promise<Set<string> | null> {
  const store = peekOpenedAgentSessionRecordStore()
  if (!store) {
    return null
  }
  const relayed = store.listRecords().flatMap((record) => {
    if (agentSessionRunPlacement(record)?.kind !== 'relayed') {
      return []
    }
    const folder = nativeChatScratchFolderName(record.sessionId)
    return present.has(folder) ? [{ folder, record }] : []
  })
  const live = new Set<string>()
  const routed = providerRelayRoute() !== null
  for (let at = 0; at < relayed.length; at += REMOVE_BATCH) {
    await Promise.all(
      relayed.slice(at, at + REMOVE_BATCH).map(async ({ folder, record }) => {
        if (!routed || (await providerRelayRunLiveness(record, { observe: true })) !== 'gone') {
          live.add(folder)
        }
      })
    )
  }
  return live
}

/** An earlier run's leftovers go, except every folder of a chat whose relayed run may still go
 *  (its agent reads them) and the newest of chats this run launched. One host holds a profile. */
async function clearEarlierRuns(root: string, remove: (path: string) => Promise<void>) {
  const length = nativeChatScratchFolderName('').length
  const listed = await readdir(root).then(
    (names) => names,
    (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? [] : null)
  )
  // An unreadable root names no chats, so none could be asked about: a later launch tries again.
  if (!listed) {
    return false
  }
  const live = await liveRelayedChats(new Set(listed.map((name) => name.slice(0, length))))
  // Without the records no chat's run is known; a later launch tries again.
  if (!live) {
    return false
  }
  // Read live: a launch that didn't wait for this names its chat before writing its folder.
  const ownedBy = (name: string, chats: (chat: string) => boolean): boolean =>
    chats(name.slice(0, length)) && ['', '.', '-'].includes(name.charAt(length))
  const isLive = (name: string) => ownedBy(name, (chat) => live.has(chat))
  const keptBy = (name: string) =>
    isLive(name) || ownedBy(name, (chat) => launched.get(root)?.has(chat) === true)
  // Only names read before the asks: a folder written since belongs to a launch of this run.
  const older = new Set(
    await olderLaunches(
      root,
      listed.filter((n) => keptBy(n) && !isLive(n))
    )
  )
  const gone = [...listed.filter((name) => !keptBy(name)), ...older]
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
 *  skipped before the chat records opened is tried again by a later launch. Resolves when it ends. */
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
