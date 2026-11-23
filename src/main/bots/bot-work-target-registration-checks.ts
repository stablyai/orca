import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import {
  sanitizeWorkTargetLabel,
  type ResolvedBotWorkTargetPlacement
} from '../../shared/agent-session/work-target/agent-session-work-target'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import { indexHiddenProjects, isRepoHidden } from '../../shared/project/catalog/hidden-projects'
import type { Project, ProjectHostSetup } from '../../shared/project/project-types'
import type { Repo } from '../../shared/repository/repo-types'
import type { Bot } from '../../shared/bot-types'
import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import { FOLLOW_UP_MESSAGE_TYPES } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-plan'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { botsRootFolder, isBotsProjectGroup } from './bot-home'
import { describeExpectedPlacementFlags } from './bot-turn-work-target'
import type { BotWorkTargetWorkspaceSummary } from './bot-work-target-refusals'

export const WORK_TARGET_NO_EFFECTS = { effectsApplied: false } as const

const FOLLOW_UP_TYPE_SET: ReadonlySet<string> = new Set(FOLLOW_UP_MESSAGE_TYPES)

/** Only status (default), dispatch, and handoff delegate work or continue a worker. */
export function isWorkTargetFollowUpMessageType(type: string | undefined): boolean {
  return FOLLOW_UP_TYPE_SET.has(type ?? 'status')
}

export function workTargetFollowUpRefusal(
  workTarget: ResolvedBotWorkTargetPlacement,
  reason: string
): OrchestrationError {
  const label = sanitizeWorkTargetLabel(workTarget.canonicalTarget.displayName)
  const expectedFlags = describeExpectedPlacementFlags(workTarget)
  const guidance = expectedFlags
    ? ` Start a worker for the selected target with \`orca orchestration worker-start ${expectedFlags}\` instead.`
    : ''
  return new OrchestrationError(
    'invalid_argument',
    `This turn targets "${label}". ${reason}${guidance} No effects were applied.`,
    WORK_TARGET_NO_EFFECTS
  )
}

function folderWorkspaceHostId(workspace: FolderWorkspace): ExecutionHostId {
  if (workspace.executionHostId) {
    return workspace.executionHostId
  }
  return workspace.connectionId ? `ssh:${workspace.connectionId}` : LOCAL_EXECUTION_HOST_ID
}

/** Verify project visibility and `projectId` host-setup binding still match `repo`. */
export function assertProjectRegistrationCurrent(args: {
  repo: Repo
  storeHostId: ExecutionHostId
  repos: readonly Repo[]
  projects: readonly Project[]
  setups: readonly ProjectHostSetup[]
  workTarget: ResolvedBotWorkTargetPlacement
  recipientLabel: string
}): void {
  const { repo, storeHostId, repos, projects, setups, workTarget, recipientLabel } = args
  const hidden = indexHiddenProjects([...repos], LOCAL_EXECUTION_HOST_ID)
  if (isRepoHidden(repo) || hidden.isRowHidden({ repoId: repo.id, hostId: storeHostId })) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `${recipientLabel} belongs to a hidden project and cannot receive work for the selected target.`
    )
  }
  const projectId = workTarget.canonicalTarget.projectId
  if (!projectId) {
    return
  }
  if (projects.length > 0 && !projects.some((project) => project.id === projectId)) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `The selected project registration for ${recipientLabel} is no longer present.`
    )
  }
  const forProject = setups.filter(
    (setup) => setup.projectId === projectId && setup.hostId === storeHostId
  )
  if (forProject.length > 0 && !forProject.some((setup) => setup.repoId === repo.id)) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `The selected project's host setup changed and no longer matches ${recipientLabel}.`
    )
  }
  const forRepo = setups.filter((setup) => setup.repoId === repo.id && setup.hostId === storeHostId)
  if (forRepo.length > 0 && !forRepo.some((setup) => setup.projectId === projectId)) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `${recipientLabel}'s repository is now registered under a different project.`
    )
  }
}

/** Verify both live and worker-recorded checkout incarnations match the selected target. */
export function assertWorkspaceIncarnationMatches(args: {
  managed: BotWorkTargetWorkspaceSummary
  workTarget: ResolvedBotWorkTargetPlacement
  recipientLabel: string
  workerWorkspaceInstanceId?: string | null
  requireRecordedInstanceId?: boolean
}): void {
  const {
    managed,
    workTarget,
    recipientLabel,
    workerWorkspaceInstanceId,
    requireRecordedInstanceId
  } = args
  if (workTarget.expectedWorkspaceInstanceId) {
    if (managed.instanceId !== workTarget.expectedWorkspaceInstanceId) {
      throw workTargetFollowUpRefusal(
        workTarget,
        `${recipientLabel}'s workspace incarnation changed after the target was selected.`
      )
    }
    if (workerWorkspaceInstanceId) {
      if (workerWorkspaceInstanceId !== workTarget.expectedWorkspaceInstanceId) {
        throw workTargetFollowUpRefusal(
          workTarget,
          `${recipientLabel} was created in an earlier workspace incarnation that does not match the selected workspace.`
        )
      }
    } else if (requireRecordedInstanceId) {
      throw workTargetFollowUpRefusal(
        workTarget,
        `${recipientLabel} has no recorded workspace incarnation and cannot be verified against the selected workspace.`
      )
    }
  } else if (
    workerWorkspaceInstanceId &&
    managed.instanceId &&
    workerWorkspaceInstanceId !== managed.instanceId
  ) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `${recipientLabel}'s workspace was replaced after the worker started.`
    )
  }
}

/** Verify a standalone `folder:<id>` workspace is live, unarchived, and not a Bot home. */
export function assertStandaloneFolderWorkTarget(args: {
  folderWorkspaceId: string
  targetWorkspaceId: string
  managed: BotWorkTargetWorkspaceSummary
  storeHostId: ExecutionHostId
  bots: readonly Bot[]
  projectGroups: readonly ProjectGroup[]
  folderWorkspaces: readonly FolderWorkspace[]
  workTarget: ResolvedBotWorkTargetPlacement
  recipientLabel: string
}): void {
  const {
    folderWorkspaceId,
    targetWorkspaceId,
    managed,
    storeHostId,
    bots,
    projectGroups,
    folderWorkspaces,
    workTarget,
    recipientLabel
  } = args
  if (workTarget.mode !== 'existing' || managed.id !== targetWorkspaceId) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `${recipientLabel} runs in a different workspace than the selected folder workspace.`
    )
  }
  if (bots.some((bot) => bot.folderWorkspaceId === folderWorkspaceId)) {
    throw workTargetFollowUpRefusal(workTarget, 'Bot home workspaces cannot be targeted.')
  }
  const botsRoot = botsRootFolder()
  const botGroupIds = new Set(
    projectGroups.filter((group) => isBotsProjectGroup(group, botsRoot)).map((group) => group.id)
  )
  const folder = folderWorkspaces.find(
    (entry) => entry.id === folderWorkspaceId && folderWorkspaceHostId(entry) === storeHostId
  )
  if (
    !folder ||
    folder.isArchived ||
    (folder.projectGroupId && botGroupIds.has(folder.projectGroupId))
  ) {
    throw workTargetFollowUpRefusal(
      workTarget,
      'The selected folder workspace is no longer available.'
    )
  }
}
