import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repository/repo-types'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import type { OrcaWorkspaceLayout } from '../../shared/orca-workspace-layout'
import type {
  WorkspaceAgentHistoryChatTally,
  WorkspaceAgentHistoryTally
} from '../../shared/workspace-agent-history/workspace-agent-history-types'
import { getRepoExecutionHostId, isLocalExecutionHost } from '../../shared/execution-host'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  splitWorktreeId,
  worktreeIdsEqual
} from '../../shared/worktree/id'
import { parseWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { AgentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { localAiVaultScanRoots } from '../ai-vault/discovery/ai-vault-scan-roots'
import { invalidateAiVaultSessionListCache } from '../ai-vault/listing/cached-session-list'
import { runWorkspaceHistoryInService } from '../ai-vault/scan-service/session-scanner-service-spawn'
import {
  createWorkspaceHistoryOwner,
  type WorkspaceHistoryOwnership
} from '../ai-vault/workspace-history/workspace-history-ownership'
import { getCodexAccountHomeSessionDirectories } from '../codex/history/rollouts/codex-account-home-discovery'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { observeStructuredSession } from '../runtime/orchestration/terminal-authority/structured-sessions/structured-worker-authority'
import type { RuntimeWorktreeLifecycleEvent } from '../runtime/workspaces/lifecycle/worktree-lifecycle-event'
import { invalidateAiVaultHostLegCache } from '../ipc/ai-vault/ai-vault-host-leg-cache'

export type WorkspaceAgentHistoryStore = {
  getSettings: () => Pick<
    GlobalSettings,
    'deleteAgentHistoryWithWorkspace' | 'workspaceDir' | 'nestWorkspaces' | 'workspaceDirHistory'
  >
  getRepos: () => Repo[]
  getFolderWorkspaces?: () => FolderWorkspace[]
  getAllWorktreeMeta: () => Record<string, unknown>
}

// An agent can sit idle at its prompt for hours; old history is the target, so recent writes are kept.
const IN_USE_WINDOW_MS = 24 * 60 * 60_000

const EMPTY_TRANSCRIPTS = { total: 0, matched: 0, bytes: 0, inUse: 0, deleted: 0, failed: 0 }

let store: WorkspaceAgentHistoryStore | null = null
let ensureChatHost: () => Promise<unknown> = () => Promise.resolve()
let queue: Promise<unknown> = Promise.resolve()

export function configureWorkspaceAgentHistory(deps: {
  store: WorkspaceAgentHistoryStore
  ensureChatHost?: () => Promise<unknown>
}): void {
  store = deps.store
  ensureChatHost = deps.ensureChatHost ?? ensureChatHost
}

/** With the setting on, a local workspace's deletion also deletes the history that ran in it. */
export function deleteAgentHistoryForRemovedWorkspace(event: RuntimeWorktreeLifecycleEvent): void {
  if (event.kind !== 'removed' || !store?.getSettings().deleteAgentHistoryWithWorkspace) {
    return
  }
  // Remote transcripts live on that host; this computer cannot prove what is there.
  if (!removedWorkspaceIsLocal(store, event) || !isSafeRemovedPath(store, event.path)) {
    return
  }
  const removedAt = Date.now()
  // Removing a folder workspace keeps the folder, so only the chats Orca bound to it are its own.
  const paths = parseWorkspaceKey(event.worktreeId)?.type === 'folder' ? [] : [event.path]
  void serialize(() =>
    runWorkspaceAgentHistory(
      'delete',
      { kind: 'removed', paths },
      {
        inUseSince: removedAt,
        // Archiving also announces `removed` but keeps the row, and its chats come back on restore.
        // A chat started after the removal belongs to a workspace recreated at the same path.
        ownsChat: (chat) =>
          chat.createdAt < removedAt &&
          worktreeIdsEqual(chat.location.workspaceId, event.worktreeId) &&
          !Object.keys(requireStore().getAllWorktreeMeta()).some((id) =>
            worktreeIdsEqual(id, event.worktreeId)
          )
      }
    )
  ).catch((error: unknown) => {
    console.warn('[workspace-agent-history] deleting history of a removed workspace failed:', error)
  })
}

export function measureDeletedWorkspaceAgentHistory(): Promise<WorkspaceAgentHistoryTally> {
  return serialize(() => runAlreadyDeleted('measure'))
}

export function deleteDeletedWorkspaceAgentHistory(): Promise<WorkspaceAgentHistoryTally> {
  return serialize(() => runAlreadyDeleted('delete'))
}

function serialize<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run)
  queue = next.catch(() => {})
  return next
}

async function runAlreadyDeleted(mode: 'measure' | 'delete'): Promise<WorkspaceAgentHistoryTally> {
  const current = requireStore()
  const scope = { kind: 'already-deleted' as const, layouts: safeWorkspaceLayouts(current) }
  const keepPaths = keepWorkspacePaths(current)
  const keepFolderNames = await liveWorktreeAdminNames(current)
  const ownsWorktreePath = createWorkspaceHistoryOwner({ scope, keepPaths, keepFolderNames })
  return runWorkspaceAgentHistory(mode, scope, {
    inUseSince: Date.now() - IN_USE_WINDOW_MS,
    ownsChat: async ({ location }) => {
      // Removing a folder workspace keeps its folder, so a missing row proves nothing about the chat.
      if (location.workspaceKind === 'folder') {
        return false
      }
      const path = worktreeIdPath(location.workspaceId)
      return path !== null && (await ownsWorktreePath({ cwd: path, filePath: '' }))
    }
  })
}

async function runWorkspaceAgentHistory(
  mode: 'measure' | 'delete',
  scope: WorkspaceHistoryOwnership['scope'],
  chats: {
    inUseSince: number
    ownsChat: (chat: AgentSessionConversationView) => boolean | Promise<boolean>
  }
): Promise<WorkspaceAgentHistoryTally> {
  const current = requireStore()
  const keepFolderNames =
    scope.kind === 'already-deleted' ? await liveWorktreeAdminNames(current) : []
  const transcripts =
    scope.kind === 'removed' && scope.paths.length === 0
      ? { ...EMPTY_TRANSCRIPTS, deletedFilePaths: [] }
      : await runWorkspaceHistoryInService({
          mode,
          ownership: { scope, keepPaths: keepWorkspacePaths(current), keepFolderNames },
          inUseSince: chats.inUseSince,
          options: await historyScanOptions()
        })
  if (transcripts.deletedFilePaths.length > 0) {
    invalidateAiVaultSessionListCache()
    invalidateAiVaultHostLegCache()
  }
  const { deletedFilePaths: _deleted, ...transcriptTally } = transcripts
  return { transcripts: transcriptTally, chats: await runChats(mode, chats.ownsChat) }
}

async function runChats(
  mode: 'measure' | 'delete',
  owns: (chat: AgentSessionConversationView) => boolean | Promise<boolean>
): Promise<WorkspaceAgentHistoryChatTally> {
  await ensureChatHost().catch(() => undefined)
  const recordStore = getStructuredAgentSessionHost()?.deps.store
  const tally: WorkspaceAgentHistoryChatTally = { total: 0, matched: 0, inUse: 0, deleted: 0 }
  if (!recordStore) {
    return tally
  }
  const local = recordStore
    .listConversations()
    .filter((chat) => isLocalExecutionHost(chat.location.executionHostId))
  tally.total = local.length
  const deletable: string[] = []
  for (const chat of local) {
    if (!(await owns(chat))) {
      continue
    }
    tally.matched++
    if (observeStructuredSession(chat.sessionId).status === 'live') {
      tally.inUse++
    } else {
      deletable.push(chat.sessionId)
    }
  }
  if (mode === 'delete' && deletable.length > 0 && !recordStore.readOnly) {
    const forgotten = await recordStore.forgetConversations(deletable)
    tally.deleted = forgotten.length
    tally.inUse += deletable.length - forgotten.length
  }
  return tally
}

/** Account homes include retired ones: a rollout linked into any home keeps its bytes on disk. */
async function historyScanOptions() {
  const roots = await localAiVaultScanRoots()
  return {
    ...roots,
    // Orca's own Antigravity chat transcripts sit behind this flag.
    includeAntigravityIdeSessions: true,
    additionalCodexSessionsDirs: [
      ...new Set([...roots.additionalCodexSessionsDirs, ...getCodexAccountHomeSessionDirectories()])
    ]
  }
}

/** Orca renames a folder after first work with `git worktree move`, which keeps the admin folder's original name. */
async function liveWorktreeAdminNames(current: WorkspaceAgentHistoryStore): Promise<string[]> {
  const names = await Promise.all(
    current
      .getRepos()
      .filter((repo) => isLocalExecutionHost(getRepoExecutionHostId(repo)))
      .map((repo) => readdir(join(repo.path, '.git', 'worktrees')).catch((): string[] => []))
  )
  return [...new Set(names.flat())]
}

/** A removed path that is empty, a root, home or above it, or a repo would scope every transcript. */
function isSafeRemovedPath(current: WorkspaceAgentHistoryStore, path: string): boolean {
  const trimmed = path.trim()
  return (
    trimmed.length > 0 &&
    dirname(trimmed) !== trimmed &&
    !isPathInsideOrEqual(trimmed, homedir()) &&
    !current.getRepos().some((repo) => isPathInsideOrEqual(trimmed, repo.path))
  )
}

function keepWorkspacePaths(current: WorkspaceAgentHistoryStore): string[] {
  return [
    ...current.getRepos().map((repo) => repo.path),
    ...(current.getFolderWorkspaces?.() ?? []).map((folder) => folder.folderPath),
    ...Object.keys(current.getAllWorktreeMeta()).flatMap((id) => worktreeIdPath(id) ?? [])
  ]
}

/** Roots that only ever hold Orca workspaces: never home itself, its ancestors, or a folder holding a repo. */
function safeWorkspaceLayouts(current: WorkspaceAgentHistoryStore): OrcaWorkspaceLayout[] {
  const settings = current.getSettings()
  const home = homedir()
  const repoPaths = current.getRepos().map((repo) => repo.path)
  return [
    { path: settings.workspaceDir, nestWorkspaces: settings.nestWorkspaces },
    ...(settings.workspaceDirHistory ?? [])
  ].filter(
    (layout) =>
      layout.path.trim().length > 0 &&
      !isPathInsideOrEqual(layout.path, home) &&
      !repoPaths.some((repoPath) => isPathInsideOrEqual(layout.path, repoPath))
  )
}

function removedWorkspaceIsLocal(
  current: WorkspaceAgentHistoryStore,
  event: Extract<RuntimeWorktreeLifecycleEvent, { kind: 'removed' }>
): boolean {
  if (event.hostId) {
    return isLocalExecutionHost(event.hostId)
  }
  // Folder events carry no SSH stamp; runChats keeps only this computer's chats.
  if (parseWorkspaceKey(event.worktreeId)?.type === 'folder') {
    return true
  }
  const repoId = splitWorktreeId(event.worktreeId)?.repoId
  const repo = current.getRepos().find((entry) => entry.id === repoId)
  return repo ? isLocalExecutionHost(getRepoExecutionHostId(repo)) : false
}

function worktreeIdPath(worktreeId: string): string | null {
  const path = splitWorktreeId(worktreeId)?.worktreePath
  if (!path) {
    return null
  }
  const suffixAt = path.lastIndexOf(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)
  return suffixAt > 0 ? path.slice(0, suffixAt) : path
}

function requireStore(): WorkspaceAgentHistoryStore {
  if (!store) {
    throw new Error('Workspace agent history is not configured.')
  }
  return store
}
