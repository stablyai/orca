import { basename } from 'node:path'
import {
  buildWorktreeProviderClaimArgv,
  buildWorktreeProviderSetupArgv
} from '../../../shared/worktree/provider/worktree-provider-command'
import type {
  WorktreeProviderClaimResponse,
  WorktreeProviderWorkspace
} from '../../../shared/worktree/provider/worktree-provider-types'
import type { GitWorktreeInfo, Worktree } from '../../../shared/worktree/types'
import { parseWorktreeProviderClaimResponse } from '../../../shared/worktree/provider/worktree-provider-response'
import type { Repo } from '../../../shared/repository/repo-types'
import { composeWorktreeId } from '../../../shared/worktree/id'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import {
  openWorktreeCreatePathClaim,
  withProjectWorktreeCreate
} from '../creation/worktree-create-in-flight'
import { WorktreeProviderError, runWorktreeProviderCommand } from './provider-process-runner'
import type { WorktreeProviderCatalog } from './provider-config-reader'
import {
  assertLocalProviderExecution,
  bestEffortRelease,
  claimFailure,
  existingProviderClaim,
  findProvider,
  stderrMessage,
  type ProviderAcquirePorts
} from './provider-claim-support'

export type ProviderAcquireResult = {
  worktree: Worktree
  claim: WorktreeProviderWorkspace
  setup: { ran: boolean; source: 'provider' | 'none' }
}

/** Claim a pooled checkout and register it as a provider-managed Orca workspace. */
export async function acquireProviderWorktree(args: {
  repo: Repo
  providerName: string
  profile?: string
  catalog: WorktreeProviderCatalog
  ports: ProviderAcquirePorts
}): Promise<ProviderAcquireResult> {
  const { repo, providerName, profile, catalog, ports } = args
  assertLocalProviderExecution(repo, ports)
  const provider = findProvider(catalog, providerName)
  const runCommand = ports.runCommand ?? runWorktreeProviderCommand
  const now = ports.now ?? Date.now

  const claimArgv = buildWorktreeProviderClaimArgv(provider, {
    repoPath: repo.path,
    ...(profile ? { profile } : {})
  })
  // A provider that printed a lease before failing may still hold the slot; release it rather than orphan it.
  const compensateClaimFailure = async (
    failure: WorktreeProviderError,
    stdout: string
  ): Promise<WorktreeProviderError> => {
    const partial = parseWorktreeProviderClaimResponse(stdout)
    if (!partial.ok && !partial.leaseId && !partial.handle) {
      return failure
    }
    const release = await bestEffortRelease({
      provider,
      repoPath: repo.path,
      response: partial.ok ? partial.value : { leaseId: partial.leaseId, handle: partial.handle },
      ports
    })
    return claimFailure(failure, release)
  }
  let response: WorktreeProviderClaimResponse
  let claimStdout = ''
  try {
    const result = await runCommand({
      argv: claimArgv,
      cwd: repo.path,
      timeoutMs: provider.timeoutSeconds * 1000,
      provider: provider.name,
      phase: 'claim'
    })
    claimStdout = result.stdout
    if (result.timedOut) {
      throw await compensateClaimFailure(
        new WorktreeProviderError(
          'worktree_provider_claim_timeout',
          `Provider "${provider.name}" claim timed out after ${provider.timeoutSeconds}s.`,
          { provider: provider.name }
        ),
        result.stdout
      )
    }
    if (result.code !== 0) {
      throw await compensateClaimFailure(
        new WorktreeProviderError(
          'worktree_provider_claim_failed',
          `Provider "${provider.name}" claim exited ${result.code ?? 'without a code'}. ${stderrMessage(result.stderr)}`,
          { provider: provider.name, exitCode: result.code }
        ),
        result.stdout
      )
    }
  } catch (error) {
    if (error instanceof WorktreeProviderError) {
      throw error
    }
    throw new WorktreeProviderError(
      'worktree_provider_claim_failed',
      error instanceof Error ? error.message : String(error),
      { provider: provider.name }
    )
  }

  const parsed = parseWorktreeProviderClaimResponse(claimStdout)
  if (!parsed.ok) {
    const release = await bestEffortRelease({
      provider,
      repoPath: repo.path,
      response: { leaseId: parsed.leaseId, handle: parsed.handle },
      ports
    })
    throw claimFailure(
      new WorktreeProviderError('worktree_provider_claim_invalid', parsed.reason, {
        provider: provider.name,
        ...(parsed.leaseId ? { leaseId: parsed.leaseId } : {}),
        ...(parsed.handle ? { handle: parsed.handle } : {}),
        stdout: claimStdout.slice(0, 2000)
      }),
      release
    )
  }
  response = parsed.value

  let worktrees: GitWorktreeInfo[]
  try {
    worktrees = await ports.listWorktrees(repo.path)
  } catch (error) {
    const release = await bestEffortRelease({
      provider,
      repoPath: repo.path,
      response,
      ports
    })
    throw claimFailure(
      new WorktreeProviderError(
        'worktree_provider_path_invalid',
        `Could not list worktrees in ${repo.path}: ${error instanceof Error ? error.message : String(error)}`,
        { provider: provider.name }
      ),
      release
    )
  }
  const gitWorktree = worktrees.find((entry) => areWorktreePathsEqual(entry.path, response.path))
  if (!gitWorktree || gitWorktree.isMainWorktree) {
    const release = await bestEffortRelease({
      provider,
      repoPath: repo.path,
      response,
      ports
    })
    throw claimFailure(
      new WorktreeProviderError(
        'worktree_provider_path_invalid',
        `Provider "${provider.name}" returned a path that is not a linked Git worktree of this repository: ${response.path}`,
        { provider: provider.name, path: response.path }
      ),
      release
    )
  }

  const worktreeId = composeWorktreeId(repo.id, gitWorktree.path)
  const pathClaim = openWorktreeCreatePathClaim()
  let registered = false
  try {
    if (!pathClaim.claim(gitWorktree.path)) {
      throw new WorktreeProviderError(
        'worktree_provider_path_conflict',
        `Another Orca workspace is already being created at ${gitWorktree.path}.`,
        { provider: provider.name, path: gitWorktree.path }
      )
    }
    const existing = ports.getMeta(worktreeId)
    const existingClaim = existing ? existingProviderClaim(existing, provider, response) : undefined
    const effectiveProfile = response.profile ?? profile
    const claim: WorktreeProviderWorkspace = {
      name: provider.name,
      ...(effectiveProfile ? { profile: effectiveProfile } : {}),
      ...(response.leaseId ? { leaseId: response.leaseId } : {}),
      ...(response.handle ? { handle: response.handle } : {}),
      ...(response.path !== gitWorktree.path ? { providerPath: response.path } : {}),
      timeoutSeconds: provider.timeoutSeconds,
      acquiredAt: existingClaim?.acquiredAt ?? now(),
      configHash: provider.configHash
    }
    const branch = gitWorktree.branch.replace(/^refs\/heads\//, '')
    const displayName = existing?.displayName?.trim() || branch || basename(gitWorktree.path)
    let setupRan = false
    if (provider.setup) {
      const setupArgv = buildWorktreeProviderSetupArgv(provider.setup, {
        repoPath: repo.path,
        worktreePath: gitWorktree.path,
        ...(effectiveProfile ? { profile: effectiveProfile } : {})
      })
      const setupResult = await runCommand({
        argv: setupArgv,
        cwd: provider.workingDirectory === 'worktree' ? gitWorktree.path : repo.path,
        timeoutMs: provider.timeoutSeconds * 1000,
        provider: provider.name,
        phase: 'setup'
      })
      if (setupResult.timedOut || setupResult.code !== 0) {
        throw new WorktreeProviderError(
          'worktree_provider_setup_failed',
          setupResult.timedOut
            ? `Provider "${provider.name}" setup timed out after ${provider.timeoutSeconds}s.`
            : `Provider "${provider.name}" setup exited ${setupResult.code ?? 'without a code'}. ${stderrMessage(setupResult.stderr)}`,
          { provider: provider.name, phase: 'setup' }
        )
      }
      setupRan = true
    }
    await withProjectWorktreeCreate(repo, async () => {
      const current = ports.getMeta(worktreeId)
      if (current !== existing) {
        existingProviderClaim(current, provider, response)
      }
      ports.setMeta(worktreeId, {
        displayName,
        lastActivityAt: now(),
        worktreeProvider: claim
      })
      registered = true
      ports.invalidateScan(repo.id)
      ports.notifyChanged(repo.id)
    })
    return {
      worktree: await ports.showWorktree(`id:${worktreeId}`),
      claim,
      setup: { ran: setupRan, source: setupRan ? 'provider' : 'none' }
    }
  } catch (error) {
    if (registered) {
      throw error
    }
    const cause =
      error instanceof WorktreeProviderError
        ? error
        : new WorktreeProviderError(
            'worktree_provider_claim_invalid',
            error instanceof Error ? error.message : String(error),
            { provider: provider.name }
          )
    const release = await bestEffortRelease({
      provider,
      repoPath: repo.path,
      response,
      ports
    })
    throw claimFailure(cause, release)
  } finally {
    pathClaim.release()
  }
}
