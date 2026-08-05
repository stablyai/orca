// Assembles a Codex CODE-audit launch: argv, env, then the spawn (Phase 7).
//
// A SEPARATE MODULE FROM THE PLAN-AUDIT LAUNCHER, deliberately.
// audited-plan-audit-launcher.ts holds its runner override in a single
// module-level variable; sharing it would mean a test that stubs one Codex role
// silently stubs the other, and a suite asserting "the code audit never spawned"
// could be satisfied by the plan reviewer's stub instead. Each role owns its own
// seam so the two cannot be confused.
//
// The ARGV BUILDER is reused verbatim: nothing in buildCodexPlanAuditPlan is
// plan-specific (--sandbox read-only, -c approval_policy="never",
// --ignore-user-config, prompt on stdin). Only the prompt differs.
import type { AuditMode } from '../../shared/audited-audit-mode-types'
import { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'
import { buildCodexPlanAuditPlan, DEFAULT_PLAN_AUDIT_MODEL } from './audited-codex-launch-plan'
import { runCodexProcess, type CodexProcessOutcome } from './audited-codex-process'
import { runNoToolsAudit } from './audited-no-tools-adapter'
import type { BundleInput } from './audited-no-tools-bundle'

export type CodeAuditLaunchContext = {
  runId: string
  taskId: string
  worktreePath: string
  prompt: string
}

export type CodeAuditLaunchArgs = CodeAuditLaunchContext & {
  /** Main-derived from userData + runId; never renderer-supplied. */
  lastMessagePath: string
  /**
   * The transport, resolved at admission.
   *
   * The branch on this value is EXCLUSIVE: `byesu_no_tools` returns before any
   * argv is built or any process is spawned, so the two transports can never
   * both run for one audit.
   */
  mode: AuditMode
  /** Bundle material, prepared by the orchestration. Only used in no-tools mode. */
  bundle?: BundleInput
}

// Test seam: lets a suite assert the admission path never reaches a spawn — the
// deterministic form of "no Codex process starts during a live fix".
type Runner = (args: CodeAuditLaunchArgs) => Promise<CodexProcessOutcome>
let runnerOverride: Runner | undefined

export function setAuditedCodeAuditRunnerForTests(runner: Runner | undefined): void {
  runnerOverride = runner
}

export async function runAuditedCodeAuditCodex(
  args: CodeAuditLaunchArgs
): Promise<CodexProcessOutcome> {
  if (runnerOverride) {
    return runnerOverride(args)
  }

  // THE NO-TOOLS BRANCH RETURNS BEFORE ANY SPAWN. Everything below this point —
  // argv construction, env preparation, runCodexProcess — is unreachable in
  // no-tools mode, which is what the "creates no subprocess" test asserts.
  if (args.mode === 'byesu_no_tools') {
    if (!args.bundle) {
      // A no-tools launch with no bundle is a programming error, not a user
      // condition. Failing closed keeps it out of the approval path.
      console.error('[auditedWorkflow] No-tools code audit reached launch without a bundle.')
      return { kind: 'no_tools_failed', reasonCode: 'bundle_too_large' }
    }
    return runNoToolsAudit({ bundle: args.bundle, scopeRoot: args.worktreePath })
  }

  // The model is a main-process constant. The renderer supplies only a taskId, so
  // it cannot influence which model audits the code.
  const plan = buildCodexPlanAuditPlan({
    model: DEFAULT_PLAN_AUDIT_MODEL,
    worktreePath: args.worktreePath,
    lastMessagePath: args.lastMessagePath
  })
  if (!plan.ok) {
    // Fail closed: a launch plan that cannot satisfy the read-only contract must
    // not degrade into a weaker invocation.
    console.error('[auditedWorkflow] Codex code-audit launch plan rejected:', plan.reasonCode)
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
