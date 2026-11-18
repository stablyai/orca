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
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { readListedFolders, readWorkspaceParents } from './deleted-workspace-folders'
import {
  sweepGoneWorkspaceFolderGroups,
  type ChatHistorySweepResult
} from './gone-workspace-folder-groups'
import {
  forgetHostNativeChats,
  listHostNativeChats,
  nativeChatWorkspaceFolder
} from './deleted-workspace-native-chats'
import { isChatStillIdleInGoneFolder } from './transcript-last-cwd'
import { isCodexRolloutStillIdleInGoneFolder } from './codex-rollout-last-cwd'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'
import { deleteCodexRolloutsPermanently } from '../../../codex/history/cleanup/codex-rollout-permanent-delete'
import { listHostCodexRolloutHomes } from '../../../codex/history/cleanup/codex-host-rollout-homes'

export type { ChatHistorySweepResult }

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
  /** Orca's own chats on this host; absent sweeps none. */
  listNativeChats?: () => readonly AgentSessionRecord[]
  /** `shouldForget` runs right before each chat's deletion. */
  forgetNativeChats?: (
    chats: AgentSessionRecord[],
    shouldForget: (chat: AgentSessionRecord) => Promise<boolean>
  ) => Promise<ChatHistorySweepResult>
  /** Read before each deletion: the user may turn the setting off while a long scan runs. */
  isEnabled: () => boolean
}

/**
 * Agents whose transcripts record the cwd on every message (Claude) or turn (Codex), so a chat
 * resumed in another workspace shows it. Agents that record it once (Pi, OMP, Copilot, Cursor)
 * can't prove that and are kept.
 */
const SWEPT_AGENTS: ReadonlySet<AiVaultAgent> = new Set(['claude', 'codex'])

function isSweepableSession(session: AiVaultSession, now: number): boolean {
  const modifiedAt = Date.parse(session.modifiedAt)
  return (
    normalizeExecutionHostId(session.executionHostId) === LOCAL_EXECUTION_HOST_ID &&
    SWEPT_AGENTS.has(session.agent) &&
    // A WSL distro's history is its own to clean, and reading it can boot the distro.
    !parseWslUncPath(session.filePath) &&
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

/** Deletes transcripts and Orca chats whose Orca workspace folder is gone, however the workspace was deleted. */
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
  const scope = { ...deps, listed, parentIds: parents.ids }
  const sessions = await listInScope(deps, parents.scopePaths)
  const transcripts = await sweepGoneWorkspaceFolderGroups(
    scope,
    // The recorded cwd only: cached scope aliases can describe an earlier symlink target.
    sessions.flatMap((session) =>
      session.cwd && isSweepableSession(session, deps.now)
        ? [{ path: session.cwd, chat: { agent: session.agent, filePath: session.filePath } }]
        : []
    ),
    // Reading one transcript can take a while, so each is checked right before its own removal:
    // the slow transcript reads first, then the cheap folder and row checks nearest the rm.
    (key, targets, stillGone) =>
      deps.deleteSessions(
        targets,
        async (target) =>
          (await (
            target.agent === 'codex'
              ? isCodexRolloutStillIdleInGoneFolder
              : isChatStillIdleInGoneFolder
          )(target.filePath, key, Date.now())) && (await stillGone())
      )
  )
  const { listNativeChats, forgetNativeChats } = deps
  const nativeChats =
    listNativeChats && forgetNativeChats
      ? await sweepGoneWorkspaceFolderGroups(
          scope,
          listNativeChats().flatMap((record) => {
            const path = nativeChatWorkspaceFolder(record, deps.now)
            return path ? [{ path, chat: record }] : []
          }),
          (_key, chats, stillGone) => forgetNativeChats(chats, stillGone)
        )
      : result
  return {
    deleted: transcripts.deleted + nativeChats.deleted,
    failed: transcripts.failed + nativeChats.failed,
    freedBytes: transcripts.freedBytes + nativeChats.freedBytes
  }
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
    deleteSessions: async (targets, shouldDelete) => {
      const isCodex = (target: ChatHistoryTarget): boolean => target.agent === 'codex'
      const others = targets.filter((target) => !isCodex(target))
      const codex = targets.filter(isCodex)
      const empty: ChatHistorySweepResult = { deleted: 0, failed: 0, freedBytes: 0 }
      const swept =
        others.length > 0 ? await deleteHostAiVaultSessionsPermanently(others, shouldDelete) : empty
      // AI Vault lists one name per rollout and refuses Codex deletes: links would bring it back.
      const rollouts =
        codex.length > 0
          ? await deleteCodexRolloutsPermanently(codex, shouldDelete, () =>
              listHostCodexRolloutHomes(store.getSettings())
            )
          : empty
      return {
        deleted: swept.deleted + rollouts.deleted,
        failed: swept.failed + rollouts.failed,
        freedBytes: swept.freedBytes + rollouts.freedBytes
      }
    },
    listNativeChats: listHostNativeChats,
    forgetNativeChats: forgetHostNativeChats,
    isEnabled: () => store.getSettings().deleteChatHistoryWithWorkspace === true
  })
}
