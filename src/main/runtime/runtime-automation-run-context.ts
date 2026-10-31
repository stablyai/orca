import type { AutomationDestination } from '../../shared/automation-owner-precondition'
import type { RuntimeRepoSelector } from './runtime-repo-selector'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Worktree } from '../../shared/worktree/types'
import type {
  AutomationUpdateInput,
  AutomationCreateInput,
  AutomationWorkspaceMode
} from '../../shared/automations-types'
import type { Repo } from '../../shared/repo-types'

export function assertAutomationRunContextMatchesTarget(
  runContext:
    | RuntimeAutomationCreateInput['runContext']
    | RuntimeAutomationUpdateInput['runContext'],
  repo: Repo | null
): void {
  if (!runContext || !repo) {
    return
  }
  if (runContext.repoId !== repo.id || runContext.path !== repo.path) {
    throw new Error('Automation project does not match its run context.')
  }
}

export type RuntimeAutomationTargetResolvers = {
  showRepo: (selector: RuntimeRepoSelector) => Promise<Repo>
  showManagedWorktree: (
    selector: string,
    hostId?: ExecutionHostId
  ) => Promise<Pick<Worktree, 'id' | 'repoId' | 'path' | 'hostId'>>
}

export type RuntimeAutomationCreateInput = Omit<
  AutomationCreateInput,
  'projectId' | 'workspaceId' | 'workspaceMode' | 'timezone'
> & {
  repo?: string
  workspace?: string
  workspaceMode?: AutomationWorkspaceMode
  timezone?: string
  destination?: AutomationDestination
}

export type RuntimeAutomationUpdateInput = Omit<
  AutomationUpdateInput,
  'projectId' | 'workspaceId'
> & {
  repo?: string
  workspace?: string
}

export type RuntimeAutomationTargetInput = Pick<
  RuntimeAutomationCreateInput,
  'repo' | 'workspace' | 'workspaceMode' | 'runContext'
>
