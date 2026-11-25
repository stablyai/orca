import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import {
  goneFolderKey,
  goneFolderOf,
  isStillGone,
  listedCatalogFingerprint,
  listedLinksUnchanged,
  readListedFolders,
  readWorkspaceParents,
  type GoneFolder,
  type ListedFolders
} from './deleted-workspace-folders'

export type ChatHistorySweepResult = { deleted: number; failed: number; freedBytes: number }

export type GoneFolderSweepScope = {
  store: RuntimeStore
  signal?: AbortSignal
  /** Read before each deletion: the user may turn the setting off while a long scan runs. */
  isEnabled: () => boolean
  /** Complete: an incomplete read can't prove any folder unclaimed. */
  listed: ListedFolders
  parentIds: Set<string>
}

/**
 * Groups chats by the deleted Orca workspace folder their path is in, then removes each group after
 * re-checking the folder and Orca's rows. `remove` asks `stillGone` right before each chat's
 * removal, after its own slower checks.
 */
export async function sweepGoneWorkspaceFolderGroups<T>(
  scope: GoneFolderSweepScope,
  chats: readonly { path: string; chat: T }[],
  remove: (
    folderKey: string,
    chats: T[],
    stillGone: () => Promise<boolean>
  ) => Promise<ChatHistorySweepResult>
): Promise<ChatHistorySweepResult> {
  const result: ChatHistorySweepResult = { deleted: 0, failed: 0, freedBytes: 0 }
  const goneByPath = new Map<string, Promise<GoneFolder | null>>()
  const byFolder = new Map<string, { folder: GoneFolder; chats: T[] }>()
  for (const { path, chat } of chats) {
    if (scope.signal?.aborted) {
      return result
    }
    let pending = goneByPath.get(path)
    if (!pending) {
      pending = goneFolderOf(path)
      goneByPath.set(path, pending)
    }
    const folder = await pending
    // Deleted means: the first missing folder sits directly in an Orca workspace parent, and Orca no
    // longer lists it or anything inside it. A missing parent (unmounted volume) never qualifies.
    if (!folder || !scope.parentIds.has(folder.ancestorId)) {
      continue
    }
    const key = goneFolderKey(folder)
    if (scope.listed.claims.has(key)) {
      continue
    }
    const group = byFolder.get(key) ?? { folder, chats: [] }
    group.chats.push(chat)
    byFolder.set(key, group)
  }

  // Re-read Orca's rows after each folder was seen gone, but stat them again only when they changed.
  type CurrentRows = { fingerprint: string; listed: ListedFolders; parentIds: Set<string> }
  let current: CurrentRows | null = null
  const readCurrent = async (): Promise<CurrentRows> => {
    const fingerprint = listedCatalogFingerprint(scope.store)
    // Claims also follow symlinks, which can be retargeted without any catalog change.
    if (current?.fingerprint === fingerprint && (await listedLinksUnchanged(current.listed))) {
      return current
    }
    const listedNow = await readListedFolders(scope.store)
    const parentsNow = await readWorkspaceParents(scope.store, listedNow)
    current = { fingerprint, listed: listedNow, parentIds: parentsNow.ids }
    return current
  }
  // A workspace archived or renamed during the scan or earlier deletions keeps its row, and that
  // row protects its chats; claims don't depend on whether the row's folder exists right now.
  const isUnclaimed = async (key: string, folder: GoneFolder): Promise<boolean> => {
    const now = await readCurrent()
    return (
      now.listed.complete && !now.listed.claims.has(key) && now.parentIds.has(folder.ancestorId)
    )
  }
  // The folder itself last: a catalog re-read can take a while, and the folder may come back meanwhile.
  const stillGone = async (key: string, folder: GoneFolder): Promise<boolean> =>
    !scope.signal?.aborted &&
    scope.isEnabled() &&
    (await isUnclaimed(key, folder)) &&
    (await isStillGone(folder))
  for (const [key, { folder, chats: group }] of byFolder) {
    if (!(await stillGone(key, folder))) {
      continue
    }
    const removed = await remove(key, group, () => stillGone(key, folder))
    result.deleted += removed.deleted
    result.failed += removed.failed
    result.freedBytes += removed.freedBytes
  }
  return result
}
