import { basename, join } from 'node:path'
import { lstat, readdir } from 'node:fs/promises'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  CloneTargetArgs,
  CloneTargetCheck
} from '../../../../shared/git/clone/clone-target-check'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import {
  deriveCloneOwnerFromUrl,
  deriveValidatedClonePath,
  getSavedProjectPathKeys
} from './repo-clone-path'
import { reuseSavedCloneTarget } from './saved-clone-target'

/** Finds the project saved at any of these path keys on the clone's host. */
export type FindSavedCloneProject = (pathKeys: string[]) => Repo | undefined

const MAX_NUMBERED_SUGGESTIONS = 20

/** Git refuses a non-empty destination, and reuseSavedCloneTarget refuses another repository's project. */
async function findCloneTargetConflict(
  clonePath: string,
  url: string,
  findSaved: FindSavedCloneProject,
  hostId: ExecutionHostId
): Promise<'other-repository' | 'not-empty' | null> {
  const pathKeys = await getSavedProjectPathKeys(clonePath)
  const saved = findSaved(pathKeys)
  if (saved && !isFolderRepo(saved)) {
    try {
      await reuseSavedCloneTarget(() => findSaved(pathKeys), url, hostId)
      return null
    } catch {
      return 'other-repository'
    }
  }
  return (await isNonEmptyPath(clonePath)) ? 'not-empty' : null
}

async function isNonEmptyPath(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    return !stats.isDirectory() || (await readdir(path)).length > 0
  } catch {
    // Missing or unreadable: the clone itself reports anything other than a free folder.
    return false
  }
}

async function suggestFreeFolderName(
  args: CloneTargetArgs,
  folderName: string,
  findSaved: FindSavedCloneProject,
  hostId: ExecutionHostId
): Promise<string | null> {
  const owner = deriveCloneOwnerFromUrl(args.url)
  const candidates = [
    ...(owner ? [`${folderName}-${owner}`] : []),
    ...Array.from({ length: MAX_NUMBERED_SUGGESTIONS }, (_, i) => `${folderName}-${i + 2}`)
  ]
  for (const candidate of candidates) {
    // A candidate already holding this repository's project is fine: the clone reuses it.
    const path = join(args.destination, candidate)
    if (!(await findCloneTargetConflict(path, args.url, findSaved, hostId))) {
      return candidate
    }
  }
  return null
}

export async function checkCloneTarget(
  args: CloneTargetArgs,
  findSaved: FindSavedCloneProject,
  hostId: ExecutionHostId
): Promise<CloneTargetCheck> {
  const clonePath = deriveValidatedClonePath(args)
  const folderName = basename(clonePath)
  const reason = await findCloneTargetConflict(clonePath, args.url, findSaved, hostId)
  if (!reason) {
    return { status: 'free', folderName }
  }
  return {
    status: 'taken',
    folderName,
    reason,
    suggestedFolderName: await suggestFreeFolderName(args, folderName, findSaved, hostId)
  }
}
