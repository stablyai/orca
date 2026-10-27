import type { GitUpstreamStatus } from '../../shared/git-status-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import { InFlightPromiseDedupe, stableInFlightKey } from '../../shared/in-flight-promise-dedupe'

/** Fix key order for JSON.stringify and make new push-target fields fail the exhaustive type check. */
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
