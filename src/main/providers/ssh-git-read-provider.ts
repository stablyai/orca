import { InFlightPromiseDedupe, stableInFlightKey } from '../../shared/in-flight-promise-dedupe'
import type { GitDiffResult } from '../../shared/git-diff-compare-types'
import type {
  GitStagingArea,
  GitStatusResult,
  GitUpstreamStatus
} from '../../shared/git-status-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import { GitStatusReadLeaseOwner } from '../git/git-status-read-lease-owner'
import { GitUpstreamStatusReadOwner } from '../git/git-upstream-status-read-owner'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { requestGitStreamable } from '../ssh/ssh-git-response-stream-reader'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { GitProviderStatusOptions } from './types'
import { isJsonRpcMethodNotFoundError } from './ssh-git-relay-errors'

const ABSENT_BRANCH_DIFF_HEAD_OID = { absent: true } as const

export class SshGitReadProvider {
  private readonly gitDiffReadDedupe = new InFlightPromiseDedupe<GitDiffResult | GitDiffResult[]>()
  private readonly statusReadLeaseOwner = new GitStatusReadLeaseOwner<GitStatusResult>()
  private readonly upstreamStatusReadOwner = new GitUpstreamStatusReadOwner()

  constructor(
    private readonly connectionId: string,
    protected readonly mux: SshChannelMultiplexer,
    private readonly hostPlatform: RemoteHostPlatform | null = null
  ) {}

  getConnectionId(): string {
    return this.connectionId
  }

  getHostPlatform(): RemoteHostPlatform | null {
    return this.hostPlatform
  }

  protected async runWithGitReadInvalidation<T>(run: () => Promise<T>): Promise<T> {
    this.invalidateGitReads()
    try {
      return await run()
    } finally {
      this.invalidateGitReads()
    }
  }

  private invalidateGitReads(): void {
    this.gitDiffReadDedupe.clear()
    this.statusReadLeaseOwner.invalidate()
    this.upstreamStatusReadOwner.invalidate()
  }

  async getStatus(
    worktreePath: string,
    options?: GitProviderStatusOptions
  ): Promise<GitStatusResult> {
    this.gitDiffReadDedupe.clear()
    const request = {
      worktreePath,
      ...(options?.admissionTier ? { admissionTier: options.admissionTier } : {}),
      ...(options?.includeIgnored ? { includeIgnored: true } : {}),
      ...(options?.includeLineStats === false ? { includeLineStats: false } : {}),
      ...(options?.bypassEffectiveUpstreamNegativeCache
        ? { bypassEffectiveUpstreamNegativeCache: true }
        : {}),
      ...(options?.reuseLineStats ? { reuseLineStats: true } : {}),
      ...(options?.branchLineTotalMergeBase === undefined
        ? {}
        : { branchLineTotalMergeBase: options.branchLineTotalMergeBase })
    }
    const key = stableInFlightKey([
      worktreePath,
      options?.admissionTier ?? 'status',
      options?.includeIgnored === true,
      options?.includeLineStats !== false,
      options?.bypassEffectiveUpstreamNegativeCache === true,
      options?.reuseLineStats === true,
      options?.branchLineTotalMergeBase ?? ''
    ])
    return this.statusReadLeaseOwner.lease(key, options?.signal, async (sharedSignal) => {
      return (await this.mux.request('git.status', request, {
        signal: sharedSignal
      })) as GitStatusResult
    })
  }

  async getSubmoduleStatus(
    worktreePath: string,
    submodulePath: string,
    area: GitStagingArea = 'unstaged'
  ): Promise<GitStatusResult> {
    this.gitDiffReadDedupe.clear()
    try {
      return (await this.mux.request('git.submoduleStatus', {
        worktreePath,
        submodulePath,
        area
      })) as GitStatusResult
    } catch (error) {
      if (isJsonRpcMethodNotFoundError(error)) {
        throw new Error(
          'SSH submodule diff support is unavailable on this relay. Reconnect the SSH target to update Orca on the host, then try again.'
        )
      }
      throw error
    }
  }

  async getDiff(
    worktreePath: string,
    filePath: string,
    staged: boolean,
    compareAgainstHead?: boolean
  ): Promise<GitDiffResult> {
    return this.gitDiffReadDedupe.run(
      stableInFlightKey(['diff', worktreePath, filePath, staged, compareAgainstHead]),
      async () =>
        (await requestGitStreamable(this.mux, 'git.diff', {
          worktreePath,
          filePath,
          staged,
          compareAgainstHead
        })) as GitDiffResult
    ) as Promise<GitDiffResult>
  }

  async getBranchDiff(
    worktreePath: string,
    baseRef: string,
    options?: { includePatch?: boolean; filePath?: string; oldPath?: string; headOid?: string }
  ): Promise<GitDiffResult[]> {
    const keyOptions = options ?? {}
    const { headOid: rawHeadOid, ...relayOptions } = keyOptions
    const headOid = rawHeadOid == null ? undefined : rawHeadOid
    return this.gitDiffReadDedupe.run(
      stableInFlightKey([
        'branchDiff',
        worktreePath,
        baseRef,
        keyOptions.includePatch ?? null,
        keyOptions.filePath ?? null,
        keyOptions.oldPath ?? null,
        headOid === undefined ? ABSENT_BRANCH_DIFF_HEAD_OID : headOid
      ]),
      async () =>
        (await requestGitStreamable(this.mux, 'git.branchDiff', {
          worktreePath,
          baseRef,
          ...relayOptions,
          ...(headOid === undefined ? {} : { headOid })
        })) as GitDiffResult[]
    ) as Promise<GitDiffResult[]>
  }

  async getCommitDiff(
    worktreePath: string,
    args: { commitOid: string; parentOid?: string | null; filePath: string; oldPath?: string }
  ): Promise<GitDiffResult> {
    return this.gitDiffReadDedupe.run(
      stableInFlightKey([
        'commitDiff',
        worktreePath,
        args.commitOid,
        args.parentOid ?? null,
        args.filePath,
        args.oldPath ?? null
      ]),
      async () =>
        (await requestGitStreamable(this.mux, 'git.commitDiff', {
          worktreePath,
          ...args
        })) as GitDiffResult
    ) as Promise<GitDiffResult>
  }

  async getUpstreamStatus(
    worktreePath: string,
    pushTarget?: GitPushTarget
  ): Promise<GitUpstreamStatus> {
    return this.upstreamStatusReadOwner.read(
      { kind: 'ssh-provider' },
      worktreePath,
      pushTarget,
      async () =>
        (await this.mux.request('git.upstreamStatus', {
          worktreePath,
          ...(pushTarget ? { pushTarget } : {})
        })) as GitUpstreamStatus
    )
  }
}
