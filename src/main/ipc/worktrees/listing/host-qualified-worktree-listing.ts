import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  parseExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host'
import type { Store } from '../../../persistence/loading-store/store'
import { PROVIDER_REQUEST_ID_MAX_UTF8_BYTES } from '../../../../shared/detected-worktree-provider-contract'
import type {
  ListDetectedWorktreesArgs,
  HostQualifiedDetectedWorktreeResult,
  DirectSshDetectedWorktreeRequest
} from '../../../../shared/detected-worktree-provider-contract'
import { isCurrentSshProviderAuthority } from '../../../ssh/ssh-provider-authority'
import {
  hasValidDirectSshAuthority,
  listDetectedWorktreesForCapturedRepo
} from './detected-provider-listing'
import {
  findExactRepoOwner,
  isCapturedRepoCurrent,
  resolveRepoOwnershipEvidence
} from './worktree-host-ownership'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { dropWorkspacesTheListingInvalidates } from '../../../persistence/restoring-sessions/invalid-workspace-layout-purge'

export async function listHostQualifiedDetectedWorktrees(
  store: Store,
  args: ListDetectedWorktreesArgs,
  providerAbort?: { signal: AbortSignal; status: () => 'canceled' | 'timed-out' }
): Promise<HostQualifiedDetectedWorktreeResult> {
  const parsedHost = parseExecutionHostId(args.executionHostId)
  const rejected = (status: 'rejected' | 'stale' | 'ambiguous-owner') => ({
    providerRequestId: args.providerRequestId,
    executionHostId: args.executionHostId,
    status
  })
  if (
    typeof args.providerRequestId !== 'string' ||
    args.providerRequestId.length === 0 ||
    Buffer.byteLength(args.providerRequestId, 'utf8') > PROVIDER_REQUEST_ID_MAX_UTF8_BYTES ||
    !parsedHost ||
    parsedHost.kind === 'runtime'
  ) {
    return rejected('rejected')
  }
  let capturedAuthority: DirectSshDetectedWorktreeRequest['expectedAuthority'] | null = null
  if (parsedHost.kind === 'ssh') {
    const directArgs = args as DirectSshDetectedWorktreeRequest
    if (
      !hasValidDirectSshAuthority(directArgs) ||
      directArgs.expectedAuthority.targetId !== parsedHost.targetId
    ) {
      return rejected('rejected')
    }
    capturedAuthority = { ...directArgs.expectedAuthority }
    if (!isCurrentSshProviderAuthority(capturedAuthority)) {
      return rejected('stale')
    }
  }

  const repoCandidates = store.getRepos().filter((candidate) => candidate.id === args.repoId)
  if (
    repoCandidates.some((candidate) => resolveRepoOwnershipEvidence(candidate).status !== 'owned')
  ) {
    return rejected('rejected')
  }
  const repo = findExactRepoOwner(store, args.repoId, args.executionHostId)
  if (!repo) {
    return rejected('ambiguous-owner')
  }
  const connectionId = getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo))
  if (
    (parsedHost.kind === 'local' && connectionId) ||
    (parsedHost.kind === 'ssh' && connectionId !== parsedHost.targetId)
  ) {
    return rejected('rejected')
  }
  const isCurrent = (): boolean => {
    if (!isCapturedRepoCurrent(store, repo, args.executionHostId)) {
      return false
    }
    if (
      (parsedHost.kind === 'local' && connectionId) ||
      (parsedHost.kind === 'ssh' && connectionId !== parsedHost.targetId)
    ) {
      return false
    }
    if (parsedHost.kind !== 'ssh') {
      return true
    }
    return capturedAuthority !== null && isCurrentSshProviderAuthority(capturedAuthority)
  }
  const result = await listDetectedWorktreesForCapturedRepo(store, repo, isCurrent, providerAbort)
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    dropWorkspacesTheListingInvalidates(store, result)
  }
  if (!result) {
    return rejected('stale')
  }
  if ('providerAbortStatus' in result) {
    return {
      providerRequestId: args.providerRequestId,
      executionHostId: args.executionHostId,
      status: result.providerAbortStatus
    }
  }
  const status = result.authoritative ? 'complete' : 'non-authoritative'
  if (parsedHost.kind === 'local') {
    return {
      status,
      providerRequestId: args.providerRequestId,
      repoId: repo.id,
      authority: { kind: 'local', executionHostId: LOCAL_EXECUTION_HOST_ID },
      result
    }
  }
  if (!capturedAuthority) {
    return rejected('rejected')
  }
  return {
    status,
    providerRequestId: args.providerRequestId,
    repoId: repo.id,
    authority: {
      kind: 'direct-ssh',
      executionHostId: args.executionHostId as `ssh:${string}`,
      ...capturedAuthority
    },
    result
  }
}
