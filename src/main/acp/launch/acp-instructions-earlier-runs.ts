import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeChatScratchFolderName } from '../../native-chat/conversation-files/native-chat-scratch-folder'
import { listProviderRelaysAtLaunch } from '../../provider-relay/app-provider-relays'
import {
  keptProviderRelaysComplete,
  providerRelayChatsKeptThisRun
} from '../../provider-relay/provider-relay-launch-inventory'

/** Removals run this many at a time, so a large leftover folder doesn't hold the launch long. */
const REMOVE_BATCH = 16
/** Chats this run wrote instructions for, by folder name. */
const launched = new Set<string>()
/** Per root: whether its clear ran, or the attempt in flight. */
const cleared = new Map<string, Promise<boolean>>()

/** An earlier run's leftovers go, except those of chats whose agent the terminal host kept running
 *  (that agent still reads them) and of chats this run launched. One host holds a profile. */
async function clearEarlierRuns(root: string, remove: (path: string) => Promise<void>) {
  await listProviderRelaysAtLaunch()
  // A daemon that didn't answer may still run agents reading these; a later launch tries again.
  if (!keptProviderRelaysComplete()) {
    return false
  }
  // Every chat's folder name has the same length; its entries are it, `<it>.md` or `<it>-<uuid>`.
  const kept = new Set([...providerRelayChatsKeptThisRun()].map(nativeChatScratchFolderName))
  launched.forEach((name) => kept.add(name))
  const length = nativeChatScratchFolderName('').length
  const keptBy = (name: string): boolean =>
    kept.has(name.slice(0, length)) && ['', '.', '-'].includes(name.charAt(length))
  const gone = (await readdir(root).catch(() => [])).filter((name) => !keptBy(name))
  for (let at = 0; at < gone.length; at += REMOVE_BATCH) {
    await Promise.all(gone.slice(at, at + REMOVE_BATCH).map((name) => remove(join(root, name))))
  }
  return true
}

/** The first launch in a run waits for the clear; one skipped while a daemon was late is tried
 *  again behind later launches, which don't wait for it. */
export async function clearEarlierRunsOnce(
  root: string,
  sessionId: string,
  remove: (path: string) => Promise<void>
): Promise<void> {
  launched.add(nativeChatScratchFolderName(sessionId))
  const attempt = cleared.get(root)
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
