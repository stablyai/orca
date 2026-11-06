import { automationTerminalLaunchInputs } from '../../shared/automation-launch-setup'
import { hostQualifiedRepoSelector } from '../runtime/workspaces/catalog/runtime-repo-selector'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { buildAutomationWorkspaceProvenance } from '../../shared/automation-workspace-provenance'
import type { Repo } from '../../shared/repo-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

type HeadlessAutomationRunForWorkspace = Pick<AutomationRun, 'id' | 'title' | 'scheduledFor'>
type RuntimeCreateManagedWorktreeArgs = Parameters<OrcaRuntimeService['createManagedWorktree']>[0]

export function buildHeadlessAutomationWorkspaceName(
  runTitle: string,
  scheduledFor: number
): string {
  // Bound names for branch/path displays while retaining a deterministic run timestamp.
  const slug = runTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const stamp = new Date(scheduledFor).toISOString().replace(/[-:]/g, '').slice(0, 13)
  return `auto-${slug || 'run'}-${stamp}`
}

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
    name: buildHeadlessAutomationWorkspaceName(run.title, run.scheduledFor),
    baseBranch: automation.baseBranch ?? undefined,
    setupDecision: automation.setupDecision ?? 'skip',
    activate: false,
    createdWithAgent: automation.agentId,
    startupAgent: automation.agentId,
    startupPrompt: automation.prompt,
    startupSuppressUpdatePrompt: true,
    ...(setup.extraAgentArgs ? { startupExtraAgentArgs: setup.extraAgentArgs } : {}),
    ...(setup.agentArgs !== undefined ? { startupAgentArgs: setup.agentArgs } : {}),
    ...(setup.sessionOptions ? { startupSessionOptions: setup.sessionOptions } : {}),
    telemetrySource: 'unknown',
    automationProvenance: buildAutomationWorkspaceProvenance(automation, run, repo, createdAt)
  }
}
