import { readdir } from 'node:fs/promises'
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

/** Per root: per-launch folders this run made, by name. */
const madeThisRun = new Map<string, Set<string>>()
/** Per root and chat (folder name): removals of that chat's entries in flight. */
const removing = new Map<string, Set<Promise<void>>>()

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
 *  (its agent reads them) and every folder this run wrote. One host holds a profile. */
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
  // Only names read before the asks; of this run's chats (a fork shares its chat's name, so one
  // may run several agents) only per-launch folders an earlier run made.
  const made = madeThisRun.get(root)
  const older = new Set(
    listed.filter(
      (n) => keptBy(n) && !isLive(n) && n.charAt(length) === '-' && made?.has(n) !== true
    )
  )
  const gone = [...listed.filter((name) => !keptBy(name)), ...older]
  for (let at = 0; at < gone.length; at += REMOVE_BATCH) {
    // Checked again per batch: a launch since names its chat before its first write.
    const batch = gone
      .slice(at, at + REMOVE_BATCH)
      .filter((name) => older.has(name) || !keptBy(name))
    // One failed removal doesn't end the sweep while others still run.
    await Promise.allSettled(
      batch.map((name) => removeTracked(root, name.slice(0, length), name, remove))
    )
  }
  return true
}

/** A launch of the chat waits for these: a reused path removed under its write would lose it. */
function removeTracked(
  root: string,
  chat: string,
  name: string,
  remove: (path: string) => Promise<void>
): Promise<void> {
  const key = `${root}\0${chat}`
  const inFlight = removing.get(key) ?? new Set<Promise<void>>()
  removing.set(key, inFlight)
  // A waiting launch only needs the removal over; its failure is the sweep's, not the launch's.
  const removal: Promise<void> = remove(join(root, name))
    .catch(() => undefined)
    .finally(() => {
      inFlight.delete(removal)
      if (inFlight.size === 0) {
        removing.delete(key)
      }
    })
  inFlight.add(removal)
  return removal
}

/**
 * A launch never waits for the clear: it names its chat (and the per-launch folder it will make)
 * first, which keeps them. It waits only for removals of its chat's entries already under way.
 * A clear skipped before the chat records opened is tried again by a later launch.
 */
export function clearEarlierRunsOnce(
  root: string,
  sessionId: string,
  remove: (path: string) => Promise<void>,
  folder?: string
): Promise<void> {
  const chat = nativeChatScratchFolderName(sessionId)
  // Even after the clear: a removal it started may still be under way.
  const removalsOfChat = (): Promise<void> => {
    const inFlight: Promise<void>[] = Array.from(removing.get(`${root}\0${chat}`) ?? [])
    return Promise.all(inFlight).then(() => undefined)
  }
  if (cleared.has(root)) {
    return removalsOfChat()
  }
  const names = launched.get(root) ?? new Set<string>()
  names.add(chat)
  launched.set(root, names)
  if (folder !== undefined) {
    const made = madeThisRun.get(root) ?? new Set<string>()
    made.add(folder)
    madeThisRun.set(root, made)
  }
  let attempt = clearing.get(root)
  if (!attempt) {
    attempt = clearEarlierRuns(root, remove)
      .catch(() => false)
      .then((done) => {
        clearing.delete(root)
        if (done) {
          cleared.add(root)
          launched.delete(root)
          madeThisRun.delete(root)
        }
        return done
      })
    clearing.set(root, attempt)
  }
  return removalsOfChat()
}
