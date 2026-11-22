import { classifyGitHubOwnerRepoFromRemoteUrl } from '../repositories/github-ssh-host-alias-resolution'
import type { PushRemote } from './pr-chat-action-recorder'
import type { PRPendingObligation } from './pr-pending-actions'
import type { PRWatchWorkspace } from './pr-watch-types'

/** A push's `To` target, its SSH host alias resolved through the checkout's config. A URL git
 *  printed without its user is tried as `git@`; a host that names no GitHub stays as parsed. */
export async function resolvePushRemote(
  workspace: PRWatchWorkspace,
  evidence: Extract<PRPendingObligation, { kind: 'pushed' }>['evidence']
): Promise<PushRemote | 'unknown' | null> {
  const url = evidence.remoteUrl
  if (!url) {
    return 'unknown'
  }
  const context = {
    repoPath: workspace.checkoutPath,
    connectionId: workspace.connectionId,
    ...(workspace.wslDistro ? { wslDistro: workspace.wslDistro } : {})
  }
  const scpLike = !url.includes('://') && !url.includes('@')
  for (const candidate of scpLike ? [url, `git@${url}`] : [url]) {
    const result = await classifyGitHubOwnerRepoFromRemoteUrl(candidate, context)
    if (result.kind === 'indeterminate') {
      return null
    }
    if (result.kind === 'github') {
      const { owner, repo, host } = result.ownerRepo
      return { host: host ?? 'github.com', owner, repo }
    }
  }
  return evidence.remote?.host.includes('.') ? evidence.remote : 'unknown'
}
