import { defineMethod } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { MobileWebWorktreeScope } from './mobile-web-source-control-host-method'
import { MobileWebSourceControlRepositoryStateSchema } from '../../../../shared/mobile-web/source-control-sync-contract'
import { gitObjectId, gitRefName } from './mobile-web-source-control-projection-bounds'

export const MOBILE_WEB_SOURCE_CONTROL_REPOSITORY_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.repositoryState',
    params: MobileWebWorktreeScope,
    handler: async (params, { runtime }) => {
      const [status, upstream, baseRef] = await Promise.all([
        runtime.getRuntimeGitStatus(params.worktree, { admissionTier: 'status' }),
        runtime.getRuntimeGitUpstreamStatus(params.worktree),
        resolveBaseRef(runtime, params.worktree)
      ])
      const { workspaceId: _workspaceId, ...projected } =
        MobileWebSourceControlRepositoryStateSchema.parse({
          workspaceId: 'page',
          head: gitObjectId(status.head),
          branch: gitRefName(status.branch),
          conflictOperation: status.conflictOperation,
          baseRef: gitRefName(baseRef),
          upstream: {
            hasUpstream: upstream.hasUpstream,
            ...(upstream.upstreamName ? { upstreamName: upstream.upstreamName.slice(0, 240) } : {}),
            ahead: upstream.ahead,
            behind: upstream.behind,
            hasConfiguredPushTarget: upstream.hasConfiguredPushTarget === true,
            behindCommitsArePatchEquivalent: upstream.behindCommitsArePatchEquivalent === true
          }
        })
      return projected
    }
  })
]

/** The workspace ref wins; the project default only fills in a workspace that never pinned one. */
async function resolveBaseRef(
  runtime: OrcaRuntimeService,
  worktree: string
): Promise<string | null> {
  const record = await runtime.showManagedWorktree(worktree)
  if (record.baseRef) {
    return record.baseRef
  }
  const fallback = await runtime.getRepoBaseRefDefault(`id:${record.repoId}`)
  return fallback.defaultBaseRef
}
