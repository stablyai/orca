import type { RuntimeStore } from '../../../runtime/construction/runtime-store-contract'
import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultAgent,
  type AiVaultSession
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { WORKSPACE_CLEANUP_RULE_GRACE_MS } from '../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { listAiVaultSessions } from '../../../ai-vault/listing/cached-session-list'
import { deleteHostAiVaultSessionsPermanently } from '../../../ai-vault/deletion/host-session-delete'
import {
  goneFolderKey,
  goneFolderOf,
  isStillGone,
  listedCatalogFingerprint,
  listedLinksUnchanged,
  readListedFolders,
  type ListedFolders,
  readWorkspaceParents,
  type GoneFolder
} from './deleted-workspace-folders'
import { isChatStillIdleInGoneFolder } from './transcript-last-cwd'

export type ChatHistorySweepResult = { deleted: number; failed: number; freedBytes: number }

export type ChatHistoryTarget = Pick<AiVaultSession, 'agent' | 'filePath'>

export type ChatHistorySweepDeps = {
  store: RuntimeStore
  now: number
  signal?: AbortSignal
  /** Sessions whose cwd is inside one of `scopePaths`, at most AI_VAULT_SCOPE_PATHS_MAX_COUNT of them. */
  listSessions: (scopePaths: string[], signal?: AbortSignal) => Promise<AiVaultSession[]>
  /** `shouldDelete` runs right before each removal, after any earlier removal in the batch. */
  deleteSessions: (
    targets: ChatHistoryTarget[],
    shouldDelete: (target: ChatHistoryTarget) => Promise<boolean>
  ) => Promise<ChatHistorySweepResult>
  /** Read before each deletion: the user may turn the setting off while a long scan runs. */
  isEnabled: () => boolean
}

/**
 * Agents whose transcripts record the cwd on every message, so a chat resumed in another workspace
 * shows it. Agents that record it once (Pi, OMP, Copilot, Cursor) can't prove that and are kept.
 */
const SWEPT_AGENTS: ReadonlySet<AiVaultAgent> = new Set(['claude'])

function isSweepableSession(session: AiVaultSession, now: number): boolean {
  const modifiedAt = Date.parse(session.modifiedAt)
  return (
    normalizeExecutionHostId(session.executionHostId) === LOCAL_EXECUTION_HOST_ID &&
    SWEPT_AGENTS.has(session.agent) &&
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
  // A listed path whose symlinks couldn't be followed could protect any folder: prove nothing.
  if (!listed.complete) {
    return result
  }
  const parents = await readWorkspaceParents(deps.store, listed)
  if (parents.ids.size === 0) {
    return result
  }
  const sessions = await listInScope(deps, parents.scopePaths)
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
    if (listed.claims.has(key)) {
      continue
    }
    const group = byFolder.get(key) ?? { folder, targets: [] }
    group.targets.push({ agent: session.agent, filePath: session.filePath })
    byFolder.set(key, group)
  }

  // Re-read Orca's rows after each folder was seen gone, but stat them again only when they changed.
  type CurrentRows = { fingerprint: string; listed: ListedFolders; parentIds: Set<string> }
  let current: CurrentRows | null = null
  const readCurrent = async (): Promise<CurrentRows> => {
    const fingerprint = listedCatalogFingerprint(deps.store)
    // Claims also follow symlinks, which can be retargeted without any catalog change.
    if (current?.fingerprint === fingerprint && (await listedLinksUnchanged(current.listed))) {
      return current
    }
    const listedNow = await readListedFolders(deps.store)
    const parentsNow = await readWorkspaceParents(deps.store, listedNow)
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
  for (const [key, { folder, targets }] of byFolder) {
    if (
      deps.signal?.aborted ||
      !deps.isEnabled() ||
      !(await isStillGone(folder)) ||
      !(await isUnclaimed(key, folder))
    ) {
      continue
    }
    // Reading one transcript can take a while, so each is checked right before its own removal.
    const deleted = await deps.deleteSessions(
      targets,
      // The slow transcript reads first: the cheap folder and row checks then run last, nearest the rm.
      async (target) =>
        (await isChatStillIdleInGoneFolder(target.filePath, key, Date.now())) &&
        !deps.signal?.aborted &&
        deps.isEnabled() &&
        (await isStillGone(folder)) &&
        (await isUnclaimed(key, folder))
    )
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
