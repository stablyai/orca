import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type {
  LinearWorkspace,
  RuntimeTaskSettings,
  TaskResumeState
} from './mobile-tasks-view-state-types'
import type { LinearTeam, RepoSummary } from './mobile-tasks-provider-detail-types'

export type HostTaskLinearStatus = {
  connected: boolean
  workspaces: LinearWorkspace[]
  selectedWorkspaceId: string | null
  activeWorkspaceId: string | null
}

export type HostTaskBootstrap = {
  settings: RuntimeTaskSettings
  taskResumeState: TaskResumeState
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  gitLabInstalled: boolean
  linearStatus: HostTaskLinearStatus
}

export type HostTaskRepository = RepoSummary

export type HostTaskLinearTeams = LinearTeam[]

export type HostTaskSettingsUpdate = Pick<
  RuntimeTaskSettings,
  | 'defaultTaskSource'
  | 'defaultTaskViewPreset'
  | 'defaultRepoSelection'
  | 'defaultLinearTeamSelection'
  | 'githubProjects'
>
