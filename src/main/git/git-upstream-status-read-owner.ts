import type { GitUpstreamStatus } from '../../shared/git-status-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import { InFlightPromiseDedupe, stableInFlightKey } from '../../shared/in-flight-promise-dedupe'

/**
 * Why the exhaustive destructure: stableInFlightKey is JSON.stringify, which is not
 * key-order stable, so push-target fields must be listed in a fixed order. Spreading
 * the remainder into Record<string, never> makes a newly added GitPushTarget field a
 * compile error instead of a silently shared lease between two different targets.
 */
function pushTargetKeyParts(pushTarget: GitPushTarget): readonly unknown[] {
  const { remoteName, branchName, remoteUrl, remoteCreated, ...rest } = pushTarget
  const exhaustive: Record<string, never> = rest
  void exhaustive
  return ['explicit-target', remoteName, branchName, remoteUrl ?? null, remoteCreated ?? null]
}

export type GitUpstreamStatusExecutionIdentity =
  | { kind: 'native' }
  | { kind: 'wsl'; distro: string }
  | { kind: 'ssh-provider' }

export class GitUpstreamStatusReadOwner {
  private readonly inFlightReads = new InFlightPromiseDedupe<GitUpstreamStatus>()

  read(
    executionIdentity: GitUpstreamStatusExecutionIdentity,
    worktreePath: string,
    pushTarget: GitPushTarget | undefined,
    load: () => Promise<GitUpstreamStatus>
  ): Promise<GitUpstreamStatus> {
    const key = stableInFlightKey([
      executionIdentity,
      worktreePath,
      pushTarget ? pushTargetKeyParts(pushTarget) : ['configured-upstream']
    ])
    return this.inFlightReads.run(key, load)
  }

  invalidate(): void {
    this.inFlightReads.clear()
  }
}

export const nativeAndWslGitUpstreamStatusReadOwner = new GitUpstreamStatusReadOwner()
