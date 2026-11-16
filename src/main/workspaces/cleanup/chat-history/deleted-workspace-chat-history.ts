import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultSession
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { isAiVaultDeletableAgent } from '../../../../shared/ai-vault/contracts/ai-vault-session-deletion'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../shared/execution-host'
import { WORKSPACE_CLEANUP_RULE_GRACE_MS } from '../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { listAiVaultSessions } from '../../../ai-vault/listing/cached-session-list'
import { deleteHostAiVaultSessionsPermanently } from '../../../ai-vault/deletion/host-session-delete'
import {
  FolderSpellings,
  holdsListedPath,
  listedWorkspaceSpellings,
  readPathState,
  workspaceFolderOf,
  workspaceParentDirectories,
  type PathState
} from './deleted-workspace-folders'

export type ChatHistorySweepResult = { deleted: number; failed: number; freedBytes: number }

export type ChatHistoryTarget = Pick<AiVaultSession, 'agent' | 'filePath'>

export type ChatHistorySweepDeps = {
  store: RuntimeStore
  now: number
  signal?: AbortSignal
  /** Sessions whose cwd is inside one of `scopePaths`, at most AI_VAULT_SCOPE_PATHS_MAX_COUNT of them. */
  listSessions: (scopePaths: string[], signal?: AbortSignal) => Promise<AiVaultSession[]>
  deleteSessions: (targets: ChatHistoryTarget[]) => Promise<ChatHistorySweepResult>
}

function isSweepableSession(session: AiVaultSession, now: number): boolean {
  const modifiedAt = Date.parse(session.modifiedAt)
  return (
    normalizeExecutionHostId(session.executionHostId) === LOCAL_EXECUTION_HOST_ID &&
    isAiVaultDeletableAgent(session.agent) &&
    // Recently written history may belong to a workspace still in use or being recreated.
    Number.isFinite(modifiedAt) &&
    now - modifiedAt >= WORKSPACE_CLEANUP_RULE_GRACE_MS
  )
}

/** Scope-only listing caps its paths, so a host with many workspace directories lists in batches. */
async function listInScope(
  deps: ChatHistorySweepDeps,
  parents: string[]
): Promise<AiVaultSession[]> {
  const sessions = new Map<string, AiVaultSession>()
  for (let start = 0; start < parents.length; start += AI_VAULT_SCOPE_PATHS_MAX_COUNT) {
    const batch = parents.slice(start, start + AI_VAULT_SCOPE_PATHS_MAX_COUNT)
    for (const session of await deps.listSessions(batch, deps.signal)) {
      sessions.set(session.filePath, session)
    }
  }
  return [...sessions.values()]
}

/** Deletes transcripts whose Orca workspace folder is gone, however the workspace was deleted. */
export async function sweepDeletedWorkspaceChatHistory(
  deps: ChatHistorySweepDeps
): Promise<ChatHistorySweepResult> {
  const result: ChatHistorySweepResult = { deleted: 0, failed: 0, freedBytes: 0 }
  const parents = workspaceParentDirectories(deps.store)
  if (parents.length === 0) {
    return result
  }
  const spellings = new FolderSpellings()
  const listed = await listedWorkspaceSpellings(deps.store, spellings)
  const sessions = await listInScope(deps, parents)
  const states = new Map<string, Promise<PathState>>()
  const stateOf = (path: string): Promise<PathState> => {
    let state = states.get(path)
    if (!state) {
      state = readPathState(path)
      states.set(path, state)
    }
    return state
  }

  const byFolder = new Map<string, ChatHistoryTarget[]>()
  for (const session of sessions) {
    if (deps.signal?.aborted) {
      return result
    }
    if (!isSweepableSession(session, deps.now)) {
      continue
    }
    const place = workspaceFolderOf([session.cwd, ...(session.cwdAliases ?? [])], parents)
    if (
      !place ||
      holdsListedPath(await spellings.of(place.folder), listed) ||
      // A missing parent is an unmounted volume or a moved folder, not a deleted workspace.
      (await stateOf(place.parent)) !== 'directory' ||
      (await stateOf(place.folder)) !== 'missing'
    ) {
      continue
    }
    const targets = byFolder.get(place.folder) ?? []
    targets.push({ agent: session.agent, filePath: session.filePath })
    byFolder.set(place.folder, targets)
  }

  for (const [folder, targets] of byFolder) {
    // The folder may have been recreated while earlier folders were deleted; look again first.
    if (deps.signal?.aborted || (await readPathState(folder)) !== 'missing') {
      continue
    }
    const deleted = await deps.deleteSessions(targets)
    result.deleted += deleted.deleted
    result.failed += deleted.failed
    result.freedBytes += deleted.freedBytes
  }
  return result
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
          { unlimited: true, scopePaths, scopeOnly: true },
          { signal: scanSignal }
        )
      ).sessions,
    deleteSessions: deleteHostAiVaultSessionsPermanently
  })
}
