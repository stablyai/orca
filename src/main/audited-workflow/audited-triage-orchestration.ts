// "Start Triage" and "Retry Triage". Invokes an injectable TriageProvider and
// CAS-transitions the task based on the validated structured result.
//
// Phase 3: Start Triage is ONE high-level operation with two internal steps —
// (1) ensure a provisioned, verified worktree while the task stays `selected`,
// then (2) the existing `selected -> triaging` CAS and provider call. The
// provider is never reached unless step 1 succeeded, so no model invocation can
// precede worktree verification.
import { getAuditedTaskRepository, getTaskProjection } from './audited-task-service'
import { createOpenAiTriageProvider, type TriageProvider } from './triage-provider'
import { readAuditedTriageApiKey } from './audited-triage-api-key-store'
import { broadcastAuditedTaskChanged } from './audited-workflow-broadcast'
import { ensureWorktreeForTask } from './audited-worktree-service'
import type { AuditedTaskRepository } from './audited-task-repository'
import type { TriageReasonCode } from '../../shared/audited-workflow-types'
import type { WorktreeReasonCode } from '../../shared/audited-worktree-types'

export type StartTriageResult =
  | { ok: true }
  | { ok: false; kind: 'triage'; reasonCode: TriageReasonCode }
  | { ok: false; kind: 'worktree'; reasonCode: WorktreeReasonCode }
  | { ok: false; kind: 'contended' }

export type RetryTriageResult = StartTriageResult

let providerOverride: TriageProvider | undefined

// Why: tests must never make a network request — this seam lets a test inject
// a deterministic fake without touching module internals, mirroring
// setAuditedTaskRepositoryForTests's pattern for the repository singleton.
export function setTriageProviderForTests(provider: TriageProvider | undefined): void {
  providerOverride = provider
}

function getTriageProvider(): TriageProvider {
  if (providerOverride) {
    return providerOverride
  }
  return createOpenAiTriageProvider({ getApiKey: readAuditedTriageApiKey })
}

function broadcastIfProjectable(taskId: string): void {
  const projection = getTaskProjection(taskId)
  if (projection) {
    broadcastAuditedTaskChanged(projection)
  }
}

/**
 * Runs the provider against an already-started run and persists the
 * outcome. Shared by startTriage and retryTriage, both of which have
 * already CAS-written `-> triaging` and a fresh `running` run before this is
 * called. `provider.runTriage` is awaited inside a try/catch: a
 * TriageProvider is a plain injected object and nothing guarantees its
 * implementation only ever resolves — a real network client can throw
 * synchronously-wrapped-in-a-rejection for cases its own try/catch didn't
 * anticipate (e.g. a bug in fetch's own error path). If that happens, the
 * run must not be left `running` forever: it is caught here, logged locally,
 * and finalized as `blocked`/`provider_error` — the IPC layer's own
 * try/catch is defense-in-depth for truly unexpected failures in the
 * orchestration layer itself, not the mechanism this cleanup relies on.
 */
async function runProviderAndFinalize(
  repo: AuditedTaskRepository,
  taskId: string,
  runId: string,
  taskTitle: string,
  taskSpecJson: string
): Promise<StartTriageResult> {
  let providerResult: Awaited<ReturnType<TriageProvider['runTriage']>>
  try {
    providerResult = await getTriageProvider().runTriage({
      title: taskTitle,
      description: parseDescription(taskSpecJson)
    })
  } catch (error) {
    console.error('[auditedWorkflow] Triage provider threw unexpectedly:', error)
    const finalized = repo.finalizeTriageRunBlocked({
      runId,
      taskId,
      reasonCode: 'provider_error'
    })
    broadcastIfProjectable(taskId)
    if (!finalized.ok) {
      return triageFailure('lock_contended')
    }
    return triageFailure('provider_error')
  }

  if (!providerResult.ok) {
    const finalized = repo.finalizeTriageRunBlocked({
      runId,
      taskId,
      reasonCode: providerResult.reasonCode
    })
    broadcastIfProjectable(taskId)
    if (!finalized.ok) {
      return triageFailure('lock_contended')
    }
    return triageFailure(providerResult.reasonCode)
  }

  const finalized = repo.finalizeTriageRunSucceeded({
    runId,
    taskId,
    decision: providerResult.output.decision,
    reasonCode: null,
    rationale: providerResult.output.rationale,
    acceptanceCriteria: providerResult.output.acceptanceCriteria,
    nextStepPrompt: providerResult.output.nextStepPrompt
  })
  broadcastIfProjectable(taskId)
  if (!finalized.ok) {
    return triageFailure('lock_contended')
  }

  return { ok: true }
}

type RepositoryFailureReasonCode = 'task_not_found' | 'illegal_transition' | 'lock_contended'

function toTriageReasonCode(reasonCode: RepositoryFailureReasonCode): TriageReasonCode {
  return reasonCode === 'task_not_found' ? 'illegal_transition' : reasonCode
}

function triageFailure(reasonCode: TriageReasonCode): StartTriageResult {
  return { ok: false, kind: 'triage', reasonCode }
}

/**
 * Step 1 of Start Triage: provision and verify the worktree while the task
 * stays `selected`. Returns null when the caller may proceed to the provider.
 */
async function ensureWorktreeBeforeProvider(taskId: string): Promise<StartTriageResult | null> {
  const worktree = await ensureWorktreeForTask(taskId)
  if (worktree.ok) {
    return null
  }
  broadcastIfProjectable(taskId)
  if ('contended' in worktree) {
    return { ok: false, kind: 'contended' }
  }
  return { ok: false, kind: 'worktree', reasonCode: worktree.reasonCode }
}

/**
 * Starts triage for a task in `selected` state. The CAS'd `selected ->
 * triaging` transition and the running-triage-run row are written atomically
 * by the repository before the provider is ever called (see
 * audited-triage-run-repository.ts), so a duplicate concurrent "Start
 * Triage" click always loses the race and gets `lock_contended` — no second
 * provider call is ever made. A sanitized projection is broadcast
 * immediately after that write commits, so other renderer windows see the
 * `triaging` state without waiting for the provider request to finish.
 */
export async function startTriage(taskId: string): Promise<StartTriageResult> {
  const repo = getAuditedTaskRepository()

  // Why check state first: a task that can never legally start triage (already
  // cancelled, already triaged, ...) must report `illegal_transition`, not a
  // worktree error — and must not provision anything. The authoritative check is
  // still the CAS in step 2; this only avoids pointless Git work and keeps the
  // reported reason truthful.
  const existing = repo.getTask(taskId)
  if (!existing || existing.state !== 'selected') {
    return triageFailure('illegal_transition')
  }

  // Step 1 — the task stays `selected` throughout. A crash after finalization
  // but before step 2 leaves worktreeReady with no running triage and no model
  // invocation on restart; the next Start Triage verifies and continues.
  const worktreeFailure = await ensureWorktreeBeforeProvider(taskId)
  if (worktreeFailure) {
    return worktreeFailure
  }

  // Step 2 — the existing canonical `selected -> triaging` CAS, unchanged.
  const started = repo.startTriageRun(taskId)
  if (!started.ok) {
    return triageFailure(toTriageReasonCode(started.reasonCode))
  }
  broadcastIfProjectable(taskId)

  return runProviderAndFinalize(
    repo,
    taskId,
    started.runId,
    started.task.title,
    started.task.specJson
  )
}

/**
 * Retries triage for a task `blocked` by a retryable triage failure
 * (`provider_unavailable`, `provider_timeout`, `provider_error`,
 * `output_invalid`, or `interrupted`) whose `pre_block_state` is `triaging`.
 * The eligibility check, the `blocked -> triaging` CAS write, and the fresh
 * `running` run insert all happen atomically in
 * audited-triage-run-repository.ts's retryTriageRun — this function refuses
 * (via the same closed reason codes as startTriage) for any non-triage
 * block, any non-retryable reason, or a task that already moved on.
 */
export async function retryTriage(taskId: string): Promise<RetryTriageResult> {
  const repo = getAuditedTaskRepository()

  // Retry is only ever for a task blocked BY TRIAGE with a retryable run. A
  // provisioning-blocked task (pre_block_state 'selected', no triage run) is
  // refused here and must use provisionWorktree instead — retryTriage can never
  // be used to bypass the provisioning-recovery contract.
  const existing = repo.getTask(taskId)
  if (!existing || existing.state !== 'blocked' || existing.preBlockState !== 'triaging') {
    return triageFailure('illegal_transition')
  }

  // C2: never re-enter triage without re-verifying the worktree — drift blocks
  // the task instead of re-invoking the provider against a mutated tree.
  const worktreeFailure = await ensureWorktreeBeforeProvider(taskId)
  if (worktreeFailure) {
    return worktreeFailure
  }

  const retried = repo.retryTriageRun(taskId)
  if (!retried.ok) {
    return triageFailure(toTriageReasonCode(retried.reasonCode))
  }
  broadcastIfProjectable(taskId)

  return runProviderAndFinalize(
    repo,
    taskId,
    retried.runId,
    retried.task.title,
    retried.task.specJson
  )
}

/**
 * Runs interrupted-triage-run recovery (see audited-triage-run-recovery.ts)
 * and broadcasts the sanitized projection for every task it moved to
 * `blocked`, so already-open renderer windows immediately stop showing a
 * stale `triaging` state left over from a crashed/killed process. Safe to
 * call multiple times (idempotent, CAS-safe) — intended to run once during
 * Audited Workflow IPC registration, i.e. once per app process lifetime.
 */
export function recoverInterruptedTriageRunsOnStartup(): void {
  const repo = getAuditedTaskRepository()
  const recovered = repo.recoverInterruptedTriageRuns()
  for (const { taskId } of recovered) {
    broadcastIfProjectable(taskId)
  }
}

function parseDescription(specJson: string): string {
  try {
    const parsed = JSON.parse(specJson) as { description?: unknown }
    return typeof parsed.description === 'string' ? parsed.description : ''
  } catch {
    return ''
  }
}
