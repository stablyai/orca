// A paired server's worker workspace, read on that server the way federationShow reaches it: the
// pinned server for the Dispatch, so a re-paired machine is never asked about another's work.
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../shared/github/repositories/repository-identity'
import type { Worktree } from '../../shared/worktree/types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { resolvePinnedFederatedServer } from '../runtime/orchestration/legacy-remote-home/pinned-federated-server'
import type { BotGitHubRepo } from './bot-work-pr-branch'
import type { BotWorkWorker, BotWorkWorkspace } from './bot-work-types'

export type BotWorkRemoteRuntime = Pick<
  OrcaRuntimeService,
  'getOrchestrationDb' | 'resolveOrchestrationWorkerServer' | 'callOrchestrationWorkerServer'
>

// Within the turn note's wait, so a slow server only drops the read.
const REMOTE_READ_TIMEOUT_MS = 10_000

type RemoteCall = <T>(method: string, params: unknown) => Promise<T>

/** A call to the worker's pinned server, or null when its Dispatch or workspace can't be read. */
async function pinnedServerCall(
  runtime: BotWorkRemoteRuntime,
  worker: BotWorkWorker
): Promise<{ call: RemoteCall; worktreeId: string } | null> {
  const federated = worker.worktreeId
    ? runtime.getOrchestrationDb().getFederatedDispatch(worker.dispatchId)
    : undefined
  if (!federated || !worker.worktreeId) {
    return null
  }
  const server = await resolvePinnedFederatedServer(runtime, federated)
  const call: RemoteCall = async <T>(method: string, params: unknown): Promise<T> =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each call names a paired Orca method whose reply is that shape, as federationShow's reader trusts it.
    (await runtime.callOrchestrationWorkerServer(
      server.environmentId,
      method,
      params,
      REMOTE_READ_TIMEOUT_MS,
      undefined,
      { expectedEnvironmentPairingRevision: server.pairingRevision }
    )) as T
  return { call, worktreeId: worker.worktreeId }
}

/** The workspace on its server, or null when the Dispatch, server or workspace can't be read; a
 *  remote read never proves a deletion. */
export async function readRemoteWorkspace(
  runtime: BotWorkRemoteRuntime,
  worker: BotWorkWorker
): Promise<BotWorkWorkspace | null> {
  const pinned = await pinnedServerCall(runtime, worker)
  if (!pinned) {
    return null
  }
  const { worktree } = await pinned.call<{
    worktree: Pick<Worktree, 'displayName' | 'branch' | 'head'>
  }>('worktree.show', { worktree: `id:${pinned.worktreeId}` })
  return {
    name: worktree.displayName || worktree.branch,
    branch: worktree.branch || null,
    head: worktree.head,
    // The server's row isn't read here: no PR rather than a GitHub call of its own.
    pullRequest: null
  }
}

/** The worker's repository's origin on its server, with the id this machine's GitHub gives that
 *  name (the server reads no id): a fork is matched by its id, which is all a pull request names of
 *  it. Null when the server names none. */
export async function readRemoteGitHubRepo(
  runtime: BotWorkRemoteRuntime,
  worker: BotWorkWorker
): Promise<BotGitHubRepo | null> {
  const pinned = await pinnedServerCall(runtime, worker)
  if (!pinned) {
    return null
  }
  const { worktree } = await pinned.call<{ worktree: Pick<Worktree, 'repoId'> }>('worktree.show', {
    worktree: `id:${pinned.worktreeId}`
  })
  const slug = await pinned.call<GitHubOwnerRepo | null>('github.repoSlug', {
    repo: `id:${worktree.repoId}`
  })
  if (!slug) {
    return null
  }
  // Loaded on first use: GitHub lookups pull the git stack into whatever imports bots.
  const { getGitHubRepositoryId } = await import('../github/client/fetch/tracked-repository')
  return { id: await getGitHubRepositoryId(slug), fullName: `${slug.owner}/${slug.repo}` }
}
