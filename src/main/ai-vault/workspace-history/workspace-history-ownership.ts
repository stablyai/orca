import { lstat, opendir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
  aiVaultSessionInScope,
  createAiVaultScopeCwdMatcher,
  sessionFileExecutionNamespace
} from '../../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import { isPathInsideOrEqual } from '../../../shared/file-access/cross-platform-path'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import type { OrcaWorkspaceLayout } from '../../../shared/worktree/paths/orca-workspace-layout'
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
  /** Original folder names of live worktrees that Orca later moved; their old paths are not deleted. */
  keepFolderNames?: readonly string[]
}

type SessionSpellings = Pick<AiVaultSession, 'cwd' | 'cwdAliases' | 'filePath'>

/** Owner checks touch the disk once per root and workspace folder, however many sessions share them. */
export function createWorkspaceHistoryOwner(
  ownership: WorkspaceHistoryOwnership
): (session: SessionSpellings) => Promise<boolean> {
  const { scope, keepPaths } = ownership
  const movedFolderNames = new Set(ownership.keepFolderNames ?? [])
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
  const parentPresence = new Map<string, Promise<boolean>>()
  const rootExists = (root: string): Promise<boolean> => {
    let known = rootPresence.get(root)
    if (!known) {
      // An unmounted volume or unreadable root proves nothing; an empty one may be a bare mount point.
      known = stat(root)
        .then(async (stats) => stats.isDirectory() && (await hasAnyEntry(root)))
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
  // A dangling link to a disconnected volume also reads as ENOENT, so the parent must be a real folder.
  const parentIsRealDirectory = async (folder: {
    root: string
    path: string
  }): Promise<boolean> => {
    const parent = dirname(folder.path)
    if (parent === folder.root) {
      return true
    }
    let known = parentPresence.get(parent)
    if (!known) {
      known = lstat(parent).then(
        (stats) => stats.isDirectory(),
        () => false
      )
      parentPresence.set(parent, known)
    }
    return known
  }
  return async (session) => {
    const spellings = [session.cwd, ...(session.cwdAliases ?? [])].filter(
      (spelling): spelling is string => Boolean(spelling)
    )
    for (const folder of spellings.flatMap((cwd) =>
      workspaceFolders(cwd, scope.layouts, session.filePath)
    )) {
      // A workspace that still exists keeps its history, whether it sits inside this folder or holds it.
      const survives = keepPaths.some(
        (keep) =>
          isPathInsideOrEqual(folder.path, keep) ||
          (keep !== folder.root &&
            isPathInsideOrEqual(folder.root, keep) &&
            isPathInsideOrEqual(keep, folder.path))
      )
      if (survives || movedFolderNames.has(basename(folder.path))) {
        continue
      }
      if (
        (await rootExists(folder.root)) &&
        (await parentIsRealDirectory(folder)) &&
        (await folderGone(folder.path))
      ) {
        return true
      }
    }
    return false
  }
}

// Reads one entry, not the whole root: deletes re-prove the root for every session.
async function hasAnyEntry(folder: string): Promise<boolean> {
  const dir = await opendir(folder)
  try {
    return (await dir.read()) !== null
  } finally {
    await dir.close()
  }
}

/** The workspace folders a cwd sits in: <root>/<name>, or <root>/<repo>/<name> when nested. */
function workspaceFolders(
  cwd: string,
  layouts: readonly OrcaWorkspaceLayout[],
  filePath: string
): { root: string; path: string }[] {
  return layouts.flatMap((layout) => {
    if (!layout.path) {
      return []
    }
    // A WSL transcript records a Linux cwd; compare it with a UNC root only inside that same distro.
    const wsl = parseWslUncPath(layout.path)
    const comparable =
      wsl &&
      cwd.startsWith('/') &&
      sessionFileExecutionNamespace(filePath) === `wsl:${wsl.distro.toLowerCase()}`
        ? wsl.linuxPath
        : layout.path
    if (!isPathInsideOrEqual(comparable, cwd)) {
      return []
    }
    const depth = layout.nestWorkspaces ? 2 : 1
    const segments = relative(comparable, cwd).split(/[\\/]/).filter(Boolean)
    return segments.length < depth
      ? []
      : [{ root: layout.path, path: join(layout.path, ...segments.slice(0, depth)) }]
  })
}
