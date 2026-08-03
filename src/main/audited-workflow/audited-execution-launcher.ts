// Assembles a launch: run-scoped settings file, env, argv, then the spawn.
// Split from the orchestration so the spawn seam is injectable in tests without
// mocking the whole entry point.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AuditedTaskState } from '../../shared/audited-workflow-types'
import type { ExecutionMode } from '../../shared/audited-execution-types'
import { prepareLocalCommitMessageAgentEnv } from '../text-generation/commit-message-agent-environment'
import { buildClaudeLaunchPlan } from './audited-claude-launch-plan'
import { runClaudeProcess, type ClaudeProcessOutcome } from './audited-claude-process'
import { getExecutionRunLogDir } from './audited-execution-output-store'

export type ExecutionLaunchContext = {
  runId: string
  taskId: string
  mode: ExecutionMode
  activeRunState: AuditedTaskState
  worktreePath: string
  prompt: string
}

export const DEFAULT_EXECUTION_MODEL = 'claude-sonnet-5'

// Test seam: lets a suite assert the admission path never reaches a spawn, and
// drive deterministic outcomes without a real `claude` binary.
type Runner = (context: ExecutionLaunchContext) => Promise<ClaudeProcessOutcome>
let runnerOverride: Runner | undefined

export function setAuditedClaudeRunnerForTests(runner: Runner | undefined): void {
  runnerOverride = runner
}

export async function runAuditedClaude(
  context: ExecutionLaunchContext
): Promise<ClaudeProcessOutcome> {
  if (runnerOverride) {
    return runnerOverride(context)
  }

  const settingsPath = join(
    getExecutionRunLogDir(app.getPath('userData'), context.runId),
    'settings.json'
  )
  const plan = buildClaudeLaunchPlan({
    mode: context.mode,
    model: DEFAULT_EXECUTION_MODEL,
    settingsPath
  })

  if (context.mode === 'direct') {
    try {
      mkdirSync(getExecutionRunLogDir(app.getPath('userData'), context.runId), { recursive: true })
      writeFileSync(settingsPath, JSON.stringify(plan.settings), 'utf8')
    } catch (error) {
      // Fail closed: the deny settings are half of Layer 1, so a run that cannot
      // write them must not start with edits enabled.
      console.error('[auditedWorkflow] Writing run-scoped deny settings failed:', error)
      return { kind: 'spawn_failed' }
    }
  }

  // Account routing matches the rest of Orca; no API key is ever constructed
  // here.
  const prepared = await prepareLocalCommitMessageAgentEnv('claude', undefined)
  const env = prepared.ok ? prepared.env : undefined

  return runClaudeProcess(context.runId, {
    argv: plan.argv,
    cwd: context.worktreePath,
    prompt: context.prompt,
    env
  })
}
