import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import { resolveProjectClaudeAccount } from '../claude-accounts/project-claude-account-resolution'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentLaunchSupportPlace, CreateSupportRuntime } from './agent-launch-support-place'

export type AgentLaunchModeHostRuntime = CreateSupportRuntime &
  Partial<Pick<OrcaRuntimeService, 'listRepos'>>

export const PROJECT_CLAUDE_ACCOUNT_DETAIL =
  'this project runs Claude on its saved account, which only a terminal can do'

/**
 * The saved account a Claude launch in this workspace pins its terminal spawn to; a structured
 * session has no way to run on it, so a host-side launch downgrades the way the renderer's plan does.
 */
export function projectClaudeAccountForLaunch(
  runtime: Partial<Pick<OrcaRuntimeService, 'listRepos'>>,
  place: AgentLaunchSupportPlace,
  agent: TuiAgent | undefined
): string | undefined {
  if (agent !== 'claude' || !('worktreeId' in place)) {
    return undefined
  }
  const repos = runtime.listRepos?.() ?? []
  return resolveProjectClaudeAccount({
    getRepo: (repoId) => repos.find((repo) => repo.id === repoId),
    worktreeId: place.worktreeId
  })
}
