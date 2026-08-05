// Spawns a Codex code audit and finalizes its outcome (Phase 7).
//
// Split from audited-code-audit-orchestration.ts so that file stays within its
// line budget without a max-lines suppression, mirroring how
// audited-plan-review-launch.ts was split from its orchestration. That module
// owns ADMISSION (is this audit legal, and does the worktree still produce the
// candidate tree); this one owns EXECUTION (spawn, capture, recompute, finalize).
import { app } from 'electron'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import type { AuditMode } from '../../shared/audited-audit-mode-types'
import { MAX_FIX_ROUNDS } from '../../shared/audited-code-audit-types'
import type { BundleInput } from './audited-no-tools-bundle'
import { getAuditedTaskRepository, getTaskProjection } from './audited-task-service'
import { broadcastAuditedTaskChanged } from './audited-workflow-broadcast'
import { verifyWorktreeForTask } from './audited-worktree-service'
import { deriveCandidateTree } from './audited-candidate-identity'
import { getCodeAuditRun } from './audited-code-audit-run-repository'
import { finalizeCodeAuditRun } from './audited-code-audit-run-finalize'
import { decideCodeAuditOutcome } from './audited-code-audit-outcome'
import { runAuditedCodeAuditCodex } from './audited-code-audit-launcher'
import { getCodeAuditLastMessagePath, getCodeAuditRunDir } from './audited-code-audit-paths'
import {
  parsePlanAuditVerdict,
  readLastMessageFile,
  removeLastMessageFile
} from './audited-plan-audit-verdict'
import { sanitizeReviewSummary } from './audited-plan-artifact-store'
import { writeExecutionOutput } from './audited-execution-output-store'
import type { AuditedTaskRow } from './audited-task-row-mapping'

function broadcastIfProjectable(taskId: string): void {
  const projection = getTaskProjection(taskId)
  if (projection) {
    broadcastAuditedTaskChanged(projection)
  }
}

export type CodeAuditLaunchInput = {
  runId: string
  taskId: string
  worktreePath: string
  prompt: string
  /** The transport resolved at admission and recorded on the run row. */
  mode: AuditMode
  /** Bundle material for the no-tools transport; absent for the CLI path. */
  bundle?: BundleInput
}

/**
 * Spawns, then on EVERY terminal outcome: write logs -> re-check ownership ->
 * re-verify the worktree -> RECOMPUTE the candidate tree -> decide -> finalize.
 */
export async function launchAndFinalizeCodeAudit(
  context: CodeAuditLaunchInput,
  task: AuditedTaskRow
): Promise<void> {
  const repo = getAuditedTaskRepository()
  const userDataPath = app.getPath('userData')
  const lastMessagePath = getCodeAuditLastMessagePath(userDataPath, context.runId)

  try {
    mkdirSync(getCodeAuditRunDir(userDataPath, context.runId), { recursive: true })
  } catch (error) {
    console.error('[auditedWorkflow] Creating the code-audit run directory failed:', error)
  }
  removeLastMessageFile(lastMessagePath)

  const outcome = await runAuditedCodeAuditCodex({ ...context, lastMessagePath })

  const stdout = 'stdout' in outcome ? outcome.stdout : ''
  const stderr = 'stderr' in outcome ? outcome.stderr : ''
  const counters = writeExecutionOutput(userDataPath, context.runId, stdout, stderr)

  const current = getCodeAuditRun(repo.getDatabase(), context.runId)
  if (!current || current.status !== 'running') {
    removeLastMessageFile(lastMessagePath)
    broadcastIfProjectable(context.taskId)
    return
  }

  const verified = await verifyWorktreeForTask(context.taskId)

  // The freshness proof for DERIVED state: derive it again. A null result is
  // treated as drift by finalizeCodeAuditRun — it is not proof of freshness.
  const recomputed = task.worktreePath
    ? await deriveCandidateTree({
        runId: `${context.runId}_final`,
        userDataPath,
        worktreePath: task.worktreePath,
        sourceRepoPath: task.sourceRepoPath,
        baseCommit: task.baseCommit,
        wslDistro: task.wslDistro,
        hostId: task.hostId
      })
    : null

  // The no-tools adapter has no file to write, so it delivers its final message
  // IN BAND. Preferring the in-band text when present is what lets ONE finalize
  // path serve both transports; the CLI path never sets it and still reads the
  // file, whose contents are the only thing that path trusts.
  const parsed =
    outcome.kind === 'exit' && outcome.exitCode === 0
      ? outcome.lastMessage !== undefined
        ? parsePlanAuditVerdict(outcome.lastMessage)
        : readAndParseVerdict(lastMessagePath)
      : null

  const decision = decideCodeAuditOutcome({
    outcome,
    driftReasonCode: verified.ok ? null : verified.reasonCode,
    parsed,
    fixRound: task.fixRound,
    maxFixRounds: MAX_FIX_ROUNDS
  })

  finalizeCodeAuditRun(
    repo.getDatabase(),
    {
      runId: context.runId,
      taskId: context.taskId,
      status: decision.status,
      reasonCode: decision.reasonCode,
      verdict: decision.verdict,
      // Redacted with the trusted context BEFORE storage, so the persisted row —
      // and therefore the projection and the renderer prop — can never carry an
      // unredacted path or branch name.
      summary:
        decision.summary === null
          ? null
          : sanitizeReviewSummary(decision.summary, {
              worktreePath: task.worktreePath,
              sourceRepoPath: task.sourceRepoPath,
              sourceRepoCommonDir: task.sourceRepoCommonDir,
              branchName: task.branchName,
              userDataPath,
              homePath: homedir()
            }),
      findingCount: decision.findingCount,
      toState: decision.toState,
      blockedReasonCode: decision.blockedReasonCode,
      preBlockState: decision.preBlockState,
      blockedPhase: decision.blockedPhase,
      eventType: decision.eventType,
      counters: {
        stdoutBytes: counters.stdoutBytes,
        stderrBytes: counters.stderrBytes,
        outputTruncated: counters.outputTruncated,
        exitCode: outcome.kind === 'exit' ? outcome.exitCode : null
      },
      recomputedTreeOid: recomputed?.ok ? recomputed.treeOid : null
    },
    Date.now()
  )

  removeLastMessageFile(lastMessagePath)
  broadcastIfProjectable(context.taskId)
}

function readAndParseVerdict(path: string): ReturnType<typeof parsePlanAuditVerdict> {
  const read = readLastMessageFile(path)
  if (!read.ok) {
    return read
  }
  return parsePlanAuditVerdict(read.text)
}
