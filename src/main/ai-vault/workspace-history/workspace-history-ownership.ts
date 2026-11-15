import { lstat, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
  aiVaultSessionInScope,
  createAiVaultScopeCwdMatcher
} from '../../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import type { OrcaWorkspaceLayout } from '../../../shared/orca-workspace-layout'
import { isENOENT } from '../../ipc/filesystem/access/filesystem-path-containment'

export type WorkspaceHistoryScope =
  /** Workspaces Orca just deleted; a transcript is theirs by the folder it ran in. */
  | { kind: 'removed'; paths: readonly string[] }
  /** Workspace folders under these roots that no longer exist on disk. */
  | { kind: 'already-deleted'; layouts: readonly OrcaWorkspaceLayout[] }

export type WorkspaceHistoryOwnership = {
  scope: WorkspaceHistoryScope
  /** Every workspace Orca still has; a nested survivor keeps its own history. */
  keepPaths: readonly string[]
}

type SessionSpellings = Pick<AiVaultSession, 'cwd' | 'cwdAliases' | 'filePath'>

/** Owner checks touch the disk once per root and workspace folder, however many sessions share them. */
export function createWorkspaceHistoryOwner(
  ownership: WorkspaceHistoryOwnership
): (session: SessionSpellings) => Promise<boolean> {
  const { scope, keepPaths } = ownership
  if (scope.kind === 'removed') {
    const inRemoved = createAiVaultScopeCwdMatcher(scope.paths)
    const survivors = keepPaths.filter((keep) =>
      scope.paths.some((removed) => isPathInsideOrEqual(removed, keep))
    )
    const inSurvivor = createAiVaultScopeCwdMatcher(survivors)
    return async (session) =>
      aiVaultSessionInScope(inRemoved, session) && !aiVaultSessionInScope(inSurvivor, session)
  }
  const rootPresence = new Map<string, Promise<boolean>>()
  const folderAbsence = new Map<string, Promise<boolean>>()
  const rootExists = (root: string): Promise<boolean> => {
    let known = rootPresence.get(root)
    if (!known) {
      // An unmounted volume or unreadable root proves nothing; an empty one may be a bare mount point.
      known = stat(root)
        .then(async (stats) => stats.isDirectory() && (await readdir(root)).length > 0)
        .catch(() => false)
      rootPresence.set(root, known)
    }
    return known
  }
  const folderGone = (folder: string): Promise<boolean> => {
    let known = folderAbsence.get(folder)
    if (!known) {
      // Only ENOENT proves deletion; permission or I/O errors leave ownership uncertain.
      known = lstat(folder).then(
        () => false,
        (error: unknown) => isENOENT(error)
      )
      folderAbsence.set(folder, known)
    }
    return known
  }
  return async (session) => {
    const spellings = [session.cwd, ...(session.cwdAliases ?? [])].filter(
      (spelling): spelling is string => Boolean(spelling)
    )
    for (const folder of spellings.flatMap((cwd) => workspaceFolders(cwd, scope.layouts))) {
      // A workspace that still exists keeps its history, whether it sits inside this folder or holds it.
      const survives = keepPaths.some(
        (keep) =>
          isPathInsideOrEqual(folder.path, keep) ||
          (keep !== folder.root &&
            isPathInsideOrEqual(folder.root, keep) &&
            isPathInsideOrEqual(keep, folder.path))
      )
      if (survives) {
        continue
      }
      if ((await rootExists(folder.root)) && (await folderGone(folder.path))) {
        return true
      }
    }
    return false
  }
}

/** The workspace folders a cwd sits in: <root>/<name>, or <root>/<repo>/<name> when nested. */
function workspaceFolders(
  cwd: string,
  layouts: readonly OrcaWorkspaceLayout[]
): { root: string; path: string }[] {
  return layouts.flatMap((layout) => {
    if (!layout.path || !isPathInsideOrEqual(layout.path, cwd)) {
      return []
    }
    const depth = layout.nestWorkspaces ? 2 : 1
    const segments = relative(layout.path, cwd).split(/[\\/]/).filter(Boolean)
    return segments.length < depth
      ? []
      : [{ root: layout.path, path: join(layout.path, ...segments.slice(0, depth)) }]
  })
}
