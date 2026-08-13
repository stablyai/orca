import type { Automation, AutomationRun } from '../../shared/automations-types'
import { buildAutomationWorkspaceProvenance } from '../../shared/automation-workspace-provenance'
import type { Repo, TuiAgent } from '../../shared/types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

type HeadlessAutomationRunForWorkspace = Pick<AutomationRun, 'id' | 'title' | 'scheduledFor'>
type RuntimeCreateManagedWorktreeArgs = Parameters<OrcaRuntimeService['createManagedWorktree']>[0]

export function buildHeadlessAutomationWorkspaceName(
  runTitle: string,
  scheduledFor: number
): string {
  // Why: generated workspace names must stay deterministic and short enough for
  // cross-provider branch/path displays while still carrying the run timestamp.
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
  agentId,
  run,
  repo,
  createdAt = Date.now()
}: {
  automation: Automation
  /** Passed separately: `automation.agentId` is null once its agent is retired. */
  agentId: TuiAgent
  run: HeadlessAutomationRunForWorkspace
  repo: Repo
  createdAt?: number
}): RuntimeCreateManagedWorktreeArgs {
  return {
    repoSelector: repo.id,
    name: buildHeadlessAutomationWorkspaceName(run.title, run.scheduledFor),
    baseBranch: automation.baseBranch ?? undefined,
    setupDecision: automation.setupDecision ?? 'skip',
    activate: false,
    createdWithAgent: agentId,
    startupAgent: agentId,
    startupPrompt: automation.prompt,
    telemetrySource: 'unknown',
    automationProvenance: buildAutomationWorkspaceProvenance(automation, run, repo, createdAt)
  }
}
