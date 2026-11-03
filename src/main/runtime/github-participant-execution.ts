import { AsyncLocalStorage } from 'node:async_hooks'
import { ghAccountBindingsEqual, type GhAccountBinding } from '../../shared/github/account-binding'
import type { GitHubParticipantRegistry } from './github-participant-registry'
import { getActiveRpcCaller, runWithActiveRpcCaller } from './rpc/rpc-active-caller'
import type { RpcCallerIdentity } from './rpc/rpc-caller-identity'

import type { GitHubExecutionIdentity } from '../../shared/github/execution-identity'
export type { GitHubExecutionIdentity } from '../../shared/github/execution-identity'

const executionIdentity = new AsyncLocalStorage<GitHubExecutionIdentity | undefined>()
const jobRequest = new AsyncLocalStorage<boolean>()

export function isActiveGitHubJobRequest(): boolean {
  return jobRequest.getStore() === true
}

export function runWithGitHubJobRequest<T>(isJob: boolean, run: () => T): T {
  return jobRequest.run(isJob || isActiveGitHubJobRequest(), run)
}

export function getActiveGitHubExecutionIdentity(): GitHubExecutionIdentity | undefined {
  return executionIdentity.getStore()
}

export function isGitHubParticipantOwner(caller: RpcCallerIdentity | undefined): boolean {
  return (
    !getActiveGitHubExecutionIdentity() &&
    !isActiveGitHubJobRequest() &&
    (caller?.kind === 'desktop' || caller?.kind === 'local-cli')
  )
}

export function runWithGitHubExecutionIdentity<T>(
  identity: GitHubExecutionIdentity | undefined,
  run: () => T
): T {
  const snapshot = identity
    ? Object.freeze({ ...identity, account: Object.freeze({ ...identity.account }) })
    : undefined
  return executionIdentity.run(snapshot, run)
}

export function captureGitHubExecutionIdentity(
  registry: GitHubParticipantRegistry | undefined,
  repoId: string
): GitHubExecutionIdentity | undefined {
  const captured = executionIdentity.getStore()
  if (captured) {
    if (!registry || captured.repoId !== repoId) {
      throw new Error('github_participant_owner_mismatch')
    }
    const caller = getActiveRpcCaller()
    if (caller?.kind === 'paired-device') {
      const participant = registry.getSelf(repoId, caller.deviceId)
      if (participant.participantId !== captured.participantId) {
        throw new Error('github_participant_owner_mismatch')
      }
    }
    const validated = registry.resolveParticipantAccount(
      repoId,
      captured.participantId,
      captured.account
    )
    return Object.freeze({ repoId, ...validated })
  }
  if (!registry?.isRepoEnabled(repoId)) {
    return undefined
  }
  const caller = getActiveRpcCaller()
  if (isGitHubParticipantOwner(caller)) {
    return undefined
  }
  if (caller?.kind !== 'paired-device') {
    throw new Error('github_participant_identity_required')
  }
  const selected = registry.resolveAccount(repoId, caller.deviceId)
  if (!selected) {
    throw new Error('github_participant_identity_required')
  }
  return Object.freeze({ repoId, ...selected })
}

export function resolveGitHubExecutionAccount(
  registry: GitHubParticipantRegistry | undefined,
  repoId: string,
  sharedAccount: GhAccountBinding | null | undefined
): GhAccountBinding | undefined {
  const identity = captureGitHubExecutionIdentity(registry, repoId)
  const account = identity?.account ?? sharedAccount
  return account ? Object.freeze({ ...account }) : undefined
}

export function createGitHubExecutionAccountResolver(
  registry: GitHubParticipantRegistry | undefined,
  repoId: string,
  sharedAccount: GhAccountBinding | null | undefined
): () => GhAccountBinding | undefined {
  const caller = getActiveRpcCaller()
  const isJob = isActiveGitHubJobRequest()
  const sharedSnapshot = sharedAccount ? Object.freeze({ ...sharedAccount }) : undefined
  try {
    const identity = captureGitHubExecutionIdentity(registry, repoId)
    const expectedAccount = identity?.account ?? sharedSnapshot
    return () =>
      runWithActiveRpcCaller(caller, () =>
        runWithGitHubJobRequest(isJob, () =>
          runWithGitHubExecutionIdentity(identity, () => {
            const account = resolveGitHubExecutionAccount(registry, repoId, sharedSnapshot)
            if (!ghAccountBindingsEqual(account, expectedAccount)) {
              throw new Error('github_participant_account_changed')
            }
            return account
          })
        )
      )
  } catch (error) {
    return () => {
      throw error
    }
  }
}

export function assertUnscopedGitHubAccess(registry: GitHubParticipantRegistry | undefined): void {
  if (registry?.hasEnabledRepos() && !isGitHubParticipantOwner(getActiveRpcCaller())) {
    throw new Error('github_participant_repo_required')
  }
}
