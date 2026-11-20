import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import {
  exactGoneFolderKey,
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
import {
  deletedFolderGeneration,
  type DeletedWorkspaceFolderRecord
} from './deleted-workspace-folder-records'

export type ChatHistorySweepResult = { deleted: number; failed: number; freedBytes: number }

export type GoneFolderSweepScope = {
  store: RuntimeStore
  signal?: AbortSignal
  /** Read before each deletion: the user may turn the setting off while a long scan runs. */
  isEnabled: () => boolean
  /** Complete: an incomplete read can't prove any folder unclaimed. */
  listed: ListedFolders
  parentIds: Set<string>
  /** Folders Orca deleted itself; a gone folder without one is never swept. */
  deletedFolders: readonly DeletedWorkspaceFolderRecord[]
}

/**
 * Groups chats by the deleted Orca workspace folder their path is in, then removes each group after
 * re-checking the folder and Orca's rows. `remove` asks `stillGone` right before each chat's
 * removal, after its own slower checks; each chat must have stayed idle since `deletedAt`.
 */
export async function sweepGoneWorkspaceFolderGroups<T>(
  scope: GoneFolderSweepScope,
  // `startedAt`: when the chat began; null (unknown) keeps it.
  chats: readonly { path: string; startedAt: number | null; chat: T }[],
  remove: (
    /** Byte-exact; see `exactGoneFolderKey`. */
    folderKey: string,
    chats: T[],
    stillGone: () => Promise<boolean>,
    deletedAt: number
  ) => Promise<ChatHistorySweepResult>
): Promise<ChatHistorySweepResult> {
  const result: ChatHistorySweepResult = { deleted: 0, failed: 0, freedBytes: 0 }
  const goneByPath = new Map<string, Promise<GoneFolder | null>>()
  const byFolder = new Map<
    string,
    { key: string; folder: GoneFolder; deletedAt: number; chats: T[] }
  >()
  for (const { path, startedAt, chat } of chats) {
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
    // Orca deleted this exact folder, and the chat began while that folder was there.
    const deletion = deletedFolderGeneration(
      scope.deletedFolders,
      folder.ancestorId,
      folder.name,
      startedAt
    )
    if (!deletion) {
      continue
    }
    const groupKey = `${exactGoneFolderKey(folder)}\0${deletion.createdAt}`
    const group = byFolder.get(groupKey) ?? {
      key,
      folder,
      deletedAt: deletion.deletedAt,
      chats: []
    }
    group.chats.push(chat)
    byFolder.set(groupKey, group)
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
  for (const { key, folder, deletedAt, chats: group } of byFolder.values()) {
    if (!(await stillGone(key, folder))) {
      continue
    }
    const removed = await remove(
      exactGoneFolderKey(folder),
      group,
      () => stillGone(key, folder),
      deletedAt
    )
    result.deleted += removed.deleted
    result.failed += removed.failed
    result.freedBytes += removed.freedBytes
  }
  return result
}
