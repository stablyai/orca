import type { GitHubOwnerRepo } from '../../../src/shared/github/pull-request-types'
import type {
  HostTaskBootstrap,
  HostTaskLinearStatus,
  HostTaskLinearTeams,
  HostTaskRepository
} from './host-task-runtime-payloads'

export type { HostTaskBootstrap, HostTaskLinearStatus, HostTaskLinearTeams, HostTaskRepository }

export type HostTaskReadOperations = {
  /** Split from `bootstrap` so the caller can commit its supported state before the settings
   *  fan-out runs. Folding the two together moves that commit behind four more requests, and a
   *  transport failure in any of them then leaves the screen with nothing rendered at all. */
  tasksSupported(): Promise<boolean>
  bootstrap(): Promise<HostTaskBootstrap>
  listRepositories(): Promise<HostTaskRepository[]>
  /** Split from the team read so a caller can commit the workspace list before asking for
   *  teams: a failed team read must not discard the workspaces the status already named. */
  linearStatus(): Promise<HostTaskLinearStatus>
  linearTeams(workspaceId: string | null): Promise<HostTaskLinearTeams>
  resolveGitHubRepoSlug(repoId: string): Promise<GitHubOwnerRepo | null>
}
