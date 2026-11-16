import { lstat } from 'node:fs/promises'
import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import {
  boundedAiVaultScopeArgs,
  type AiVaultSession
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { isAiVaultDeletableAgent } from '../../../../shared/ai-vault/contracts/ai-vault-session-deletion'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../shared/execution-host'
import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../../../shared/cross-platform-path'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { WORKSPACE_CLEANUP_RULE_GRACE_MS } from '../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { isENOENT } from '../../../ipc/filesystem/access/filesystem-path-containment'
import { managedWorktreeDirectories } from '../../../ai-vault-search/scope/session-search-scope-paths'
import { listWorkspaceCleanupOwnedRepos } from '../workspace-cleanup-run-evidence'
import { listAiVaultSessions } from '../../../ai-vault/listing/cached-session-list'
import { deleteHostAiVaultSessionsPermanently } from '../../../ai-vault/deletion/host-session-delete'

export type ChatHistorySweepResult = { deleted: number; failed: number; freedBytes: number }

export type ChatHistoryTarget = Pick<AiVaultSession, 'agent' | 'filePath'>

export type ChatHistorySweepDeps = {
  store: RuntimeStore
  now: number
  signal?: AbortSignal
  listSessions: (scopePaths: string[], signal?: AbortSignal) => Promise<AiVaultSession[]>
  deleteSessions: (targets: ChatHistoryTarget[]) => Promise<ChatHistorySweepResult>
}

const NOTHING_DELETED: ChatHistorySweepResult = { deleted: 0, failed: 0, freedBytes: 0 }

/** Directories whose children are this host's Orca workspaces; shared flat roots can hold folders Orca never made. */
function workspaceParentDirectories(store: RuntimeStore): string[] {
  const settings = store.getSettings()
  const directories: string[] = []
  for (const repo of listWorkspaceCleanupOwnedRepos(store).values()) {
    // A WSL distro's transcripts carry Linux paths this process cannot check for absence.
    if (parseWslUncPath(repo.path)) {
      continue
    }
    for (const directory of managedWorktreeDirectories(repo, settings)) {
      if (!parseWslUncPath(directory)) {
        directories.push(directory)
      }
    }
  }
  return directories
}

/** Paths Orca still lists: an archived workspace keeps its row while its folder is gone. */
function listedWorkspacePaths(store: RuntimeStore): Set<string> {
  const paths = new Set<string>()
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta())) {
    const path = splitWorktreeId(worktreeId)?.worktreePath
    if (path) {
      paths.add(normalizeRuntimePathForComparison(path))
    }
  }
  for (const repo of store.getRepos()) {
    paths.add(normalizeRuntimePathForComparison(repo.path))
  }
  return paths
}

/** The workspace folder a session ran in: the first segment under a workspace parent directory. */
function workspaceFolderOf(
  session: AiVaultSession,
  parents: readonly string[]
): { parent: string; folder: string } | null {
  for (const cwd of [session.cwd, ...(session.cwdAliases ?? [])]) {
    if (!cwd) {
      continue
    }
    for (const parent of parents) {
      const relative = relativePathInsideRoot(parent, cwd)
      const name = relative?.split(/[\\/]/)[0]
      if (name) {
        return { parent, folder: resolveRuntimePath(parent, name) }
      }
    }
  }
  return null
}

type PathState = 'directory' | 'missing' | 'other'

async function readPathState(path: string): Promise<PathState> {
  try {
    return (await lstat(path)).isDirectory() ? 'directory' : 'other'
  } catch (error) {
    // Only proven absence counts: a permission or I/O error must never read as a deleted workspace.
    return isENOENT(error) ? 'missing' : 'other'
  }
}

/** Deletes transcripts whose Orca workspace folder is gone, however the workspace was deleted. */
export async function sweepDeletedWorkspaceChatHistory(
  deps: ChatHistorySweepDeps
): Promise<ChatHistorySweepResult> {
  const parents = workspaceParentDirectories(deps.store)
  if (parents.length === 0) {
    return NOTHING_DELETED
  }
  const listed = listedWorkspacePaths(deps.store)
  const sessions = await deps.listSessions(parents, deps.signal)
  const states = new Map<string, Promise<PathState>>()
  const stateOf = (path: string): Promise<PathState> => {
    let state = states.get(path)
    if (!state) {
      state = readPathState(path)
      states.set(path, state)
    }
    return state
  }

  const targets: ChatHistoryTarget[] = []
  for (const session of sessions) {
    if (deps.signal?.aborted) {
      return NOTHING_DELETED
    }
    const modifiedAt = Date.parse(session.modifiedAt)
    if (
      normalizeExecutionHostId(session.executionHostId) !== LOCAL_EXECUTION_HOST_ID ||
      !isAiVaultDeletableAgent(session.agent) ||
      // Recently written history may belong to a workspace being recreated or still in use.
      !Number.isFinite(modifiedAt) ||
      deps.now - modifiedAt < WORKSPACE_CLEANUP_RULE_GRACE_MS
    ) {
      continue
    }
    const place = workspaceFolderOf(session, parents)
    if (!place || listed.has(normalizeRuntimePathForComparison(place.folder))) {
      continue
    }
    // A missing parent is an unmounted volume or a moved folder, not a deleted workspace.
    if (
      (await stateOf(place.parent)) !== 'directory' ||
      (await stateOf(place.folder)) !== 'missing'
    ) {
      continue
    }
    targets.push({ agent: session.agent, filePath: session.filePath })
  }
  return targets.length > 0 ? deps.deleteSessions(targets) : NOTHING_DELETED
}

/** The sweep against this host's real session history: AI Vault's listing and its validated delete. */
export function deleteChatHistoryOfDeletedWorkspaces(
  store: RuntimeStore,
  signal: AbortSignal
): Promise<ChatHistorySweepResult> {
  return sweepDeletedWorkspaceChatHistory({
    store,
    now: Date.now(),
    signal,
    listSessions: async (scopePaths, scanSignal) =>
      (
        await listAiVaultSessions(
          // Unlimited: a capped list would leave older sessions of deleted workspaces behind.
          { unlimited: true, ...boundedAiVaultScopeArgs(scopePaths, true) },
          { signal: scanSignal }
        )
      ).sessions,
    deleteSessions: deleteHostAiVaultSessionsPermanently
  })
}
