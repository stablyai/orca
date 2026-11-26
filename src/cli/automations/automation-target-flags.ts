import {
  buildWorkspaceRunContext,
  type WorkspaceRunContext
} from '../../shared/work-items/task-source-context'
import type { ProjectHostSetup } from '../../shared/project/project-types'
import type { CommandHandler } from '../dispatch/dispatch'
import { getOptionalStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import { getOptionalWorktreeSelector } from '../workspace-selection/workspace-selector'
import {
  assertWorkspaceTargetFlagsCompatible,
  hasWorkspaceProjectTarget,
  resolveProjectCreateTarget
} from '../workspaces/worktree-project-target'

/** The target an automation's flags name; empty when none does. */
export async function getExplicitTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<{ repo?: string; workspace?: string; runContext?: WorkspaceRunContext }> {
  assertWorkspaceTargetFlagsCompatible(flags)
  const repo = getOptionalStringFlag(flags, 'repo')
  if (repo && getOptionalStringFlag(flags, 'workspace')) {
    throw new RuntimeClientError('invalid_argument', 'Use either --repo or --workspace, not both.')
  }
  if (hasWorkspaceProjectTarget(flags) && getOptionalStringFlag(flags, 'workspace')) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --workspace or project target flags, not both.'
    )
  }
  const projectTarget = await resolveProjectCreateTarget(flags, client)
  if (projectTarget) {
    return {
      repo: projectTarget.repoSelector,
      runContext: buildAutomationRunContextFromSetup(projectTarget.setup)
    }
  }
  const workspace = await getOptionalWorktreeSelector(flags, 'workspace', cwd, client)
  return { repo, workspace }
}

function buildAutomationRunContextFromSetup(setup: ProjectHostSetup): WorkspaceRunContext {
  const runContext = buildWorkspaceRunContext({
    projectId: setup.projectId,
    hostId: setup.hostId,
    projectHostSetupId: setup.id,
    repoId: setup.repoId,
    path: setup.path
  })
  if (!runContext) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Project host setup is missing automation run context fields: ${setup.id}`
    )
  }
  return runContext
}
