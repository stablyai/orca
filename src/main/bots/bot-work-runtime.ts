// The work record as this runtime reads it: links from the conversation store, workers from
// orchestration, workspaces from the runtime's worktrees.
import { existsSync } from 'node:fs'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host/execution-host'
import { splitWorktreeId } from '../../shared/worktree/id'
import { parseWslUncPath } from '../../shared/file-access/wsl-paths'
import {
  findLink,
  findLinkForSession,
  type ExternalConversationLinkStore
} from '../external-conversations/external-conversation-links'
import {
  readWorkspacePR,
  type WorkspacePRReadStore
} from '../github/pull-requests/refresh/workspace-pr-read'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  BotWorkRecord,
  type BotTurnAddress,
  type BotWorkWorker,
  type BotWorkWorkspace
} from './bot-work-record'
import type { BotWorkHost } from './bot-work-store'
import { botWorkStoreFile, type BotWorkRemote } from './bot-work-ops'
import type { BotsDbWorkerClient } from './db-worker/bots-db-worker-client'
import type { BotWorkWorkspaceShow } from './bot-work-workspace-show'
import type { ScopedWorktreeReads } from '../runtime/workspaces/catalog/scoped-worktree-row-resolution'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { readWorkers } from './bot-work-workers-read'
import { readRemoteWorkspace } from './bot-work-remote-workspace'
import { getRemoteDispatch } from '../runtime/orchestration/db/remote-owned/remote-dispatch-records'

type TurnMessage = Pick<AgentJournalMessageItem, 'origin'>

export type BotWorkRuntime = Pick<
  OrcaRuntimeService,
  | 'getOrchestrationDb'
  | 'resolveOrchestrationWorkerServer'
  | 'callOrchestrationWorkerServer'
  | 'getOrchestrationFleetAgentStatusSnapshot'
  | 'ensureStructuredAgentSessionHost'
  | 'getAgentStatusSnapshotFn'
> & {
  showManagedTerminalWorkspace: BotWorkWorkspaceShow
  linkStore: () =>
    | (ExternalConversationLinkStore & WorkspacePRReadStore & { getRepos: () => readonly Repo[] })
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

/** `check`'s answer under `key`, asked once per batch; without a batch, asked every time. */
function existsOnce(key: string, check: () => boolean, known?: Map<string, boolean>): boolean {
  const answer = known?.get(key) ?? check()
  known?.set(key, answer)
  return answer
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
  // a stopped WSL distro or an unmounted drive proves nothing.
  if (
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
    !parseWslUncPath(parsed.worktreePath) &&
    existsOnce(`repo:${repo.path}`, () => existsSync(repo.path), exists) &&
    !existsOnce(`worktree:${parsed.worktreePath}`, () => existsSync(parsed.worktreePath), exists)
  ) {
    return 'gone'
  }
  const worktree = await runtime.showManagedTerminalWorkspace(`id:${worktreeId}`, undefined, reads)
  // The PR the workspace's row shows, from the shared cache; a stale one is read again in the background.
  const pr = readWorkspacePR(store, { ...worktree, id: worktreeId }, repo)
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

/** `db`: the runtime's bots DB worker, which runs the store's SQL. */
export function runtimeBotWork(
  runtime: BotWorkRuntime,
  db: Pick<BotsDbWorkerClient, 'work'>
): BotWorkRecord {
  const stores = new Map<string, BotWorkRemote>()
  return new BotWorkRecord({
    // Per profile: a profile switch reads that profile's record.
    store: () => {
      const path = botWorkStoreFile(getProfileUserDataPath())
      const store = stores.get(path) ?? db.work(path)
      stores.set(path, store)
      return store
    },
    workers: (dispatchIds) => readWorkers(runtime, dispatchIds),
    workspaces: () => workspaceReader(runtime),
    turnAddress: (sessionId, message) => readTurnAddress(runtime, sessionId, message),
    conversationTitle: (address) => {
      if (address.source === 'chat') {
        const chat = getStructuredAgentSessionHost()?.deps.store.getConversation(address.externalId)
        return chat?.conversationName || null
      }
      const store = runtime.linkStore()
      return (store && findLink(store, address)?.link.title) || null
    }
  })
}
