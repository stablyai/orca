// The work record as this runtime reads it: links from the conversation store, workers from
// orchestration, workspaces from the runtime's worktrees.
import { accessSync, existsSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host/execution-host'
import { splitWorktreeId } from '../../shared/worktree/id'
import { parseWslUncPath } from '../../shared/file-access/wsl-paths'
import {
  findLink,
  findLinkForSession,
  type ExternalConversationLinkStore
} from '../external-conversations/external-conversation-links'
import { readWorkspaceReviewPR } from '../../shared/sidebar-list/feed-facts/workspace-review-facts'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Bot } from '../../shared/bot-types'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  BotWorkRecord,
  type BotTurnAddress,
  type BotWorkWorker,
  type BotWorkWorkspace
} from './bot-work-record'
import { BotWorkStore, botWorkStoreFile, type BotWorkHost } from './bot-work-store'
import type { BotWorkWorkspaceShow } from './bot-work-workspace-show'
import type { ScopedWorktreeReads } from '../runtime/workspaces/catalog/scoped-worktree-row-resolution'
import { isInBotHome } from './bot-home-membership'
import { readWorkers } from './bot-work-workers-read'
import { readRemoteGitHubRepo, readRemoteWorkspace } from './bot-work-remote-workspace'
import { getRemoteDispatch } from '../runtime/orchestration/db/remote-owned/remote-dispatch-records'
import { worktreesUnderHomes } from './bot-handed-workspaces'
import { workspaceOnBranch, type BotGitHubRepo, type BotPrRepo } from './bot-work-pr-branch'
import { normalizeLocalBranchName } from '../runtime/workspaces/catalog/runtime-worktree-selection'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { WorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { WorkspaceLineage } from '../../shared/worktree/lineage-types'

type TurnMessage = Pick<AgentJournalMessageItem, 'origin'>

export type BotWorkRuntime = Pick<
  OrcaRuntimeService,
  | 'getOrchestrationDb'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
  | 'getOrchestrationFleetAgentStatusSnapshot'
  | 'ensureStructuredAgentSessionHost'
  | 'getAgentStatusSnapshotFn'
  | 'bots'
> & {
  showManagedTerminalWorkspace: BotWorkWorkspaceShow
  linkStore: () =>
    | (ExternalConversationLinkStore & {
        getRepos: () => readonly Repo[]
        getGitHubCache: RuntimeStore['getGitHubCache']
      })
    | null
}

type Repo = ReturnType<ExternalConversationLinkStore['getRepos']>[number]

/** 'local', or the paired server a Dispatch runs on: federated, or the server's own. */
export function botWorkHostOf(db: OrchestrationDb, dispatchId: string): BotWorkHost {
  return (
    db.getFederatedDispatch(dispatchId)?.environment_id ??
    getRemoteDispatch(db, dispatchId)?.environment_id ??
    'local'
  )
}

/** One batch's workspace reader; `reads`: its repo reads, shared by every workspace it reads.
 *  `exists`: path checks shared too, only where a 'gone' never closes anything (item views). */
export function workspaceReader(
  runtime: BotWorkRuntime,
  reads: ScopedWorktreeReads = new Map(),
  exists?: Map<string, boolean>
): (worker: BotWorkWorker) => Promise<BotWorkWorkspace | 'gone' | null> {
  return async (worker) => {
    if (worker.host !== 'local') {
      return readRemoteWorkspace(runtime, worker)
    }
    return worker.worktreeId ? readLocalWorkspace(runtime, worker.worktreeId, reads, exists) : null
  }
}

function existsOnce(path: string, check: (path: string) => boolean, known?: Map<string, boolean>) {
  // Keyed by check too: the repo and worktree checks read an unreadable path differently.
  const key = `${check.name}:${path}`
  const answer = known?.get(key) ?? check(path)
  known?.set(key, answer)
  return answer
}

/** Absent only on ENOENT/ENOTDIR: an unreadable path may still be there. */
function mayExist(path: string): boolean {
  try {
    accessSync(path)
    return true
  } catch (error) {
    return !isDefinitiveAbsence(error)
  }
}

/** One of this host's worktrees as the work record reads it; 'gone' only with proof. */
async function readLocalWorkspace(
  runtime: BotWorkRuntime,
  worktreeId: string,
  reads?: ScopedWorktreeReads,
  exists?: Map<string, boolean>
): Promise<BotWorkWorkspace | 'gone' | null> {
  const store = runtime.linkStore()
  const parsed = splitWorktreeId(worktreeId)
  if (!store || !parsed) {
    return null
  }
  const repo = store.getRepos().find((entry) => entry.id === parsed.repoId)
  if (!repo) {
    return null
  }
  // Only this machine's own disk proves a deletion, with the repository still there: an SSH host,
  // a stopped WSL distro or an unreadable path proves nothing.
  if (
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
    !parseWslUncPath(parsed.worktreePath) &&
    existsOnce(repo.path, existsSync, exists) &&
    !existsOnce(parsed.worktreePath, mayExist, exists)
  ) {
    return 'gone'
  }
  const worktree = await runtime.showManagedTerminalWorkspace(`id:${worktreeId}`, undefined, reads)
  // The PR the workspace's row shows: the desktop's cached read, never a GitHub call of its own.
  const pr = readWorkspaceReviewPR(worktree, repo, store.getGitHubCache().pr)
  return {
    name: worktree.displayName || worktree.branch,
    branch: worktree.branch || null,
    head: worktree.head,
    pullRequest: pr
      ? {
          number: pr.number,
          url: pr.url,
          state: pr.state,
          checks: pr.checksStatus,
          review: pr.reviewDecision ?? null,
          headSha: pr.headSha ?? null
        }
      : null
  }
}

export type BotHomeLineage = {
  listWorkspaceLineage: () => Promise<Readonly<Record<WorkspaceKey, WorkspaceLineage>>>
}

/** The GitHub repository a worktree of this host tracks on this branch, else its origin. */
async function localGitHubRepo(
  runtime: BotWorkRuntime,
  worktreeId: string,
  branch: string
): Promise<BotGitHubRepo | null> {
  const parsed = splitWorktreeId(worktreeId)
  const repo =
    parsed &&
    runtime
      .linkStore()
      ?.getRepos()
      .find((entry) => entry.id === parsed.repoId)
  if (!repo) {
    return null
  }
  // Loaded on first use: GitHub lookups pull the git stack into whatever imports bots.
  const { getGitHubTrackedRepository } = await import('../github/client/fetch/tracked-repository')
  return getGitHubTrackedRepository(
    repo.path,
    normalizeLocalBranchName(branch),
    getRepoRoutingConnectionId(repo)
  )
}

/** The GitHub repository a worker's workspace tracks on its branch: here, or on its paired server
 *  by name. Null when it can't be told. */
export async function workerGitHubRepo(
  runtime: BotWorkRuntime,
  worker: BotWorkWorker,
  branch: string
): Promise<BotGitHubRepo | null> {
  if (worker.host !== 'local') {
    return readRemoteGitHubRepo(runtime, worker)
  }
  return worker.worktreeId ? localGitHubRepo(runtime, worker.worktreeId, branch) : null
}

/**
 * Whether a worktree under a bot's home (made there by its workers, or handed to it) has this branch
 * checked out in this repository: a pull request from it is the bot's work, even after its work row
 * closed. One that can't be read counts as not on it.
 */
export async function botHomeWorktreeOnBranch(
  runtime: BotWorkRuntime & BotHomeLineage,
  repo: BotPrRepo,
  headRef: string
): Promise<boolean> {
  const homes = runtime.bots.list().map((bot) => folderWorkspaceKey(bot.folderWorkspaceId))
  const under = worktreesUnderHomes(await runtime.listWorkspaceLineage(), homes)
  for (const worktreeId of new Set([...under.values()].flatMap((ids) => [...ids]))) {
    const workspace = await readLocalWorkspace(runtime, worktreeId).catch(() => null)
    const branch = workspace && workspace !== 'gone' ? workspace.branch : null
    if (
      branch &&
      (await workspaceOnBranch(
        { branch, githubRepo: () => localGitHubRepo(runtime, worktreeId, branch) },
        repo,
        headRef
      ))
    ) {
      return true
    }
  }
  return false
}

/** The bot conversation a session's turn came from. A bot's Chat is its owner's too, so there only
 *  a connector's message names one; its link then names the conversation that wrote last. A thread's
 *  chat keeps its thread for an owner's message typed in Orca, which is marked asked in the app. */
async function readTurnAddress(
  runtime: BotWorkRuntime,
  sessionId: string,
  message: TurnMessage
): Promise<BotTurnAddress | null> {
  const store = runtime.linkStore()
  if (!store) {
    return null
  }
  const link = findLinkForSession(store, sessionId)?.link
  if (!link?.bot) {
    return null
  }
  if (link.bot.kind === 'bot-chat' && message.origin !== 'connector') {
    return null
  }
  return {
    botId: link.bot.botId,
    address: { source: link.source, externalId: link.externalId },
    ...(message.origin === 'connector' ? {} : { askedInApp: true })
  }
}

export function runtimeBotWork(runtime: BotWorkRuntime): BotWorkRecord {
  const stores = new Map<string, BotWorkStore>()
  return new BotWorkRecord({
    // Per profile: a profile switch reads that profile's record.
    store: () => {
      const path = botWorkStoreFile(getProfileUserDataPath())
      const store = stores.get(path) ?? BotWorkStore.open(path)
      stores.set(path, store)
      return store
    },
    workers: (dispatchIds) => readWorkers(runtime, dispatchIds),
    workspaces: () => workspaceReader(runtime),
    turnAddress: (sessionId, message) => readTurnAddress(runtime, sessionId, message),
    conversationTitle: (address) => {
      const store = runtime.linkStore()
      return (store && findLink(store, address)?.link.title) || null
    }
  })
}

/** Reads which conversation a bot's turn is when a worker start begins, so a message arriving while
 *  it starts can't move it; records the worker once it started. */
export function prepareBotWorkerStart(
  runtime: {
    bots: { list: () => readonly Pick<Bot, 'folderWorkspaceId'>[] }
    botWork: Pick<BotWorkRecord, 'turnOf' | 'started'>
    /** 'local', or the paired server a Dispatch runs on. */
    hostOf: (dispatchId: string) => BotWorkHost
  },
  callerSession: { sessionId: string; workspaceId: string } | undefined
): (start: { taskId: string; dispatchId: string }) => void {
  const turn = Promise.resolve()
    .then(() =>
      callerSession && isInBotHome(runtime.bots, callerSession)
        ? runtime.botWork.turnOf(callerSession.sessionId)
        : null
    )
    .catch(warnUnrecorded)
  return ({ taskId, dispatchId }) => {
    void turn
      .then(async (address) => {
        if (address) {
          const host = runtime.hostOf(dispatchId)
          await runtime.botWork.started(address, { taskId, dispatchId, host })
        }
      })
      .catch(warnUnrecorded)
  }
}

function warnUnrecorded(error: unknown): null {
  console.warn('[bots] recording a bot worker failed', error)
  return null
}
