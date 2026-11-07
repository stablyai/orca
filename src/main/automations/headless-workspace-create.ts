import { buildAutomationWorkspaceName } from '../../shared/automation-workspace-name'
import { automationTerminalLaunchInputs } from '../../shared/automation-launch-setup'
import { hostQualifiedRepoSelector } from '../runtime/workspaces/catalog/runtime-repo-selector'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { buildAutomationWorkspaceProvenance } from '../../shared/automation-workspace-provenance'
import type { Repo } from '../../shared/repo-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

type HeadlessAutomationRunForWorkspace = Pick<AutomationRun, 'id' | 'title' | 'scheduledFor'>
type RuntimeCreateManagedWorktreeArgs = Parameters<OrcaRuntimeService['createManagedWorktree']>[0]

export function buildHeadlessAutomationWorktreeCreateArgs({
  automation,
  run,
  repo,
  createdAt = Date.now()
}: {
  automation: Automation
  run: HeadlessAutomationRunForWorkspace
  repo: Repo
  createdAt?: number
}): RuntimeCreateManagedWorktreeArgs {
  const setup = automationTerminalLaunchInputs(automation)
  return {
    repoSelector: hostQualifiedRepoSelector(`id:${repo.id}`, getRepoExecutionHostId(repo)),
    name: buildAutomationWorkspaceName(run.title, run.scheduledFor, automation.timezone),
    baseBranch: automation.baseBranch ?? undefined,
    setupDecision: automation.setupDecision ?? 'skip',
    // Only the approved content runs; a branch that changed it skips setup.
    ...(automation.setupTrustHash ? { approvedSetupHash: automation.setupTrustHash } : {}),
    activate: false,
    createdWithAgent: automation.agentId,
    startupAgent: automation.agentId,
    startupPrompt: automation.prompt,
    startupSuppressUpdatePrompt: true,
    startupTitle: run.title,
    ...(setup.extraAgentArgs ? { startupExtraAgentArgs: setup.extraAgentArgs } : {}),
    ...(setup.agentArgs !== undefined ? { startupAgentArgs: setup.agentArgs } : {}),
    ...(setup.sessionOptions ? { startupSessionOptions: setup.sessionOptions } : {}),
    telemetrySource: 'unknown',
    automationProvenance: buildAutomationWorkspaceProvenance(automation, run, repo, createdAt)
  }
}
