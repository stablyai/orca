import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import { requireReachableGitRoute } from '../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../shared/execution-host'
import type { HostedReviewLocalGitOptions } from './hosted-review-git-options'

export async function readCurrentReviewHead(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewLocalGitOptions = {},
  runGit = gitExecFileAsync
): Promise<string | null> {
  requireReachableGitRoute(getConnectionExecutionHostId(connectionId))
  try {
    const result = await runGit(['rev-parse', 'HEAD'], {
      cwd: repoPath,
      ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
      ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
    })
    return result.stdout.trim() || null
  } catch {
    return null
  }
}
