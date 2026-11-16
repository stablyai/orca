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
  goneFolderKey,
  goneFolderOf,
  isStillGone,
  readListedFolders,
  readWorkspaceParents,
  type GoneFolder
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
  /** Read before each deletion: the user may turn the setting off while a long scan runs. */
  isEnabled: () => boolean
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
  scopePaths: string[]
): Promise<AiVaultSession[]> {
  const sessions = new Map<string, AiVaultSession>()
  for (let start = 0; start < scopePaths.length; start += AI_VAULT_SCOPE_PATHS_MAX_COUNT) {
    const batch = scopePaths.slice(start, start + AI_VAULT_SCOPE_PATHS_MAX_COUNT)
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
  const listed = await readListedFolders(deps.store)
  const parents = await readWorkspaceParents(deps.store, listed)
  if (parents.ids.size === 0) {
    return result
  }
  const sessions = await listInScope(deps, parents.scopePaths)
  // The scan can take minutes: a workspace archived meanwhile must still be protected.
  const listedNow = await readListedFolders(deps.store)
  const goneByCwd = new Map<string, Promise<GoneFolder | null>>()

  const byFolder = new Map<string, { folder: GoneFolder; targets: ChatHistoryTarget[] }>()
  for (const session of sessions) {
    if (deps.signal?.aborted) {
      return result
    }
    // The recorded cwd only: cached scope aliases can describe an earlier symlink target.
    const cwd = session.cwd
    if (!cwd || !isSweepableSession(session, deps.now)) {
      continue
    }
    let pending = goneByCwd.get(cwd)
    if (!pending) {
      pending = goneFolderOf(cwd)
      goneByCwd.set(cwd, pending)
    }
    const folder = await pending
    // Deleted means: the first missing folder sits directly in an Orca workspace parent, and Orca no
    // longer lists it or anything inside it. A missing parent (unmounted volume) never qualifies.
    if (!folder || !parents.ids.has(folder.ancestorId)) {
      continue
    }
    const key = goneFolderKey(folder)
    if (listed.gone.has(key) || listedNow.gone.has(key)) {
      continue
    }
    const group = byFolder.get(key) ?? { folder, targets: [] }
    group.targets.push({ agent: session.agent, filePath: session.filePath })
    byFolder.set(key, group)
  }

  for (const { folder, targets } of byFolder.values()) {
    // Earlier deletions took time: the volume may be gone, the folder recreated, the setting off.
    if (deps.signal?.aborted || !deps.isEnabled() || !(await isStillGone(folder))) {
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
    deleteSessions: deleteHostAiVaultSessionsPermanently,
    isEnabled: () => store.getSettings().deleteChatHistoryWithWorkspace === true
  })
}
