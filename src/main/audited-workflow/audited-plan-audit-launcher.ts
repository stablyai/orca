// Assembles a Codex plan-audit launch: argv, env, then the spawn. Split from the
// orchestration so the spawn seam is injectable in tests without mocking the
// whole entry point (mirroring audited-execution-launcher.ts).
import { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'
import { buildCodexPlanAuditPlan, DEFAULT_PLAN_AUDIT_MODEL } from './audited-codex-launch-plan'
import { runCodexProcess, type CodexProcessOutcome } from './audited-codex-process'

export type PlanAuditLaunchContext = {
  runId: string
  taskId: string
  worktreePath: string
  prompt: string
}

export type PlanAuditLaunchArgs = PlanAuditLaunchContext & {
  /** Main-derived from userData + runId; never renderer-supplied. */
  lastMessagePath: string
}

// Test seam: lets a suite assert the admission path never reaches a spawn, and
// drive deterministic outcomes without a real `codex` binary.
type Runner = (args: PlanAuditLaunchArgs) => Promise<CodexProcessOutcome>
let runnerOverride: Runner | undefined

export function setAuditedCodexRunnerForTests(runner: Runner | undefined): void {
  runnerOverride = runner
}

export async function runAuditedCodex(args: PlanAuditLaunchArgs): Promise<CodexProcessOutcome> {
  if (runnerOverride) {
    return runnerOverride(args)
  }

  // The model is a main-process constant. The renderer supplies only a taskId,
  // so it cannot influence which model reviews the plan.
  const plan = buildCodexPlanAuditPlan({
    model: DEFAULT_PLAN_AUDIT_MODEL,
    worktreePath: args.worktreePath,
    lastMessagePath: args.lastMessagePath
  })
  if (!plan.ok) {
    // Fail closed: a launch plan that cannot satisfy the read-only contract must
    // not degrade into a weaker invocation.
    console.error('[auditedWorkflow] Codex launch plan rejected:', plan.reasonCode)
    return { kind: 'launch_plan_invalid' }
  }

  // Account routing matches the rest of Orca; no API key is constructed here.
  const prepared = await prepareLocalCommitMessageAgentEnv('codex', undefined)
  const env = prepared.ok ? prepared.env : undefined

  return runCodexProcess(args.runId, {
    argv: plan.argv,
    cwd: args.worktreePath,
    prompt: args.prompt,
    env
  })
}
