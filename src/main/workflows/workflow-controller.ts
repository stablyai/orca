import { randomUUID } from 'node:crypto'
import { parseWorkflowPreset } from '../../shared/workflow/workflow-preset-migration'
import {
  hasBlockingWorkflowIssues,
  validateWorkflowDefinition,
  type WorkflowHostCapabilities
} from '../../shared/workflow/workflow-validation'
import {
  appendWorkflowEvent,
  createWorkflowRunRecord
} from '../../shared/workflow/workflow-run-state'
import {
  resolveWorkflowApproval,
  retryWorkflowTask
} from '../../shared/workflow/workflow-task-settlement'
import { isWorkflowRunTerminal, type WorkflowRun } from '../../shared/workflow/workflow-run-types'
import type { WorkflowPreset } from '../../shared/workflow/workflow-definition-schema'
import type { WorkflowOrcaAdapter } from './workflow-orca-adapter-contract'
import type { WorkflowStore } from './workflow-store'
import { WorkflowRequestError, WorkflowValidationError } from './workflow-request-error'
import { releaseHeldWorkflowMessage } from './workflow-held-messages'
import { WorkflowRunSession, type WorkflowSessionEffects } from './workflow-run-session'
import { dispatchWorkflowAgent } from './workflow-task-dispatch'
import { reconcileWorkflowRun } from './workflow-run-reconciliation'
import { pumpWorkflowMail } from './workflow-mail-pump'
import {
  cancelWorkflowRun,
  finalizeWorkflowRun,
  launchWorkflowRun,
  recoverWorkflowRun,
  requestWorkflowApproval,
  stopRunningTaskForRetry
} from './workflow-run-lifecycle'

const EFFECTS: WorkflowSessionEffects = {
  dispatchAgent: dispatchWorkflowAgent,
  requestApproval: requestWorkflowApproval,
  finalize: finalizeWorkflowRun,
  reconcile: reconcileWorkflowRun,
  pumpMail: pumpWorkflowMail
}

export type WorkflowControllerOptions = {
  now?: () => Date
  reconcileIntervalMs?: number
  capabilities?: () => Promise<WorkflowHostCapabilities | null>
}

export class WorkflowController {
  private readonly sessions = new Map<string, WorkflowRunSession>()
  private readonly now: () => Date

  constructor(
    readonly store: WorkflowStore,
    private readonly adapter: WorkflowOrcaAdapter,
    private readonly options: WorkflowControllerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
  }

  private session(run: WorkflowRun): WorkflowRunSession {
    let session = this.sessions.get(run.id)
    if (!session || session.isClosed) {
      session = new WorkflowRunSession(run, {
        store: this.store,
        adapter: this.adapter,
        now: this.now,
        effects: EFFECTS,
        reconcileIntervalMs: this.options.reconcileIntervalMs ?? 3_000
      })
      this.sessions.set(run.id, session)
    }
    return session
  }

  private requireRun(id: string): WorkflowRun {
    const run = this.store.getRun(id)
    if (!run) {
      throw new WorkflowRequestError('workflow_run_not_found', `Workflow run ${id} was not found.`)
    }
    return run
  }

  private liveSession(id: string, options: { reopenFailed?: boolean } = {}): WorkflowRunSession {
    const run = this.requireRun(id)
    if (isWorkflowRunTerminal(run.status) && !(options.reopenFailed && run.status === 'failed')) {
      throw new WorkflowRequestError('workflow_run_settled', `Workflow run ${id} has ended.`)
    }
    return this.session(run)
  }

  async savePreset(raw: unknown): Promise<WorkflowPreset> {
    const parsed = parseWorkflowPreset(raw)
    if (!parsed.ok) {
      throw new WorkflowRequestError('invalid_preset', parsed.error)
    }
    return this.store.savePreset({ ...parsed.preset, updatedAt: this.now().toISOString() })
  }

  async validate(definition: unknown) {
    return validateWorkflowDefinition(definition, (await this.options.capabilities?.()) ?? null)
  }

  async startRun(args: {
    presetId: string
    objective: string
    worktreeSelector: string
    worktreeLabel: string
    preset?: unknown
  }): Promise<WorkflowRun> {
    let preset = this.store.getPreset(args.presetId)
    if (args.preset !== undefined) {
      const inline = parseWorkflowPreset(args.preset)
      if (!inline.ok) {
        throw new WorkflowRequestError('invalid_preset', inline.error)
      }
      preset = inline.preset
    }
    if (!preset) {
      throw new WorkflowRequestError('preset_not_found', `Preset ${args.presetId} was not found.`)
    }
    if (!/^id:[^\s]+$/.test(args.worktreeSelector)) {
      throw new WorkflowRequestError(
        'invalid_workspace',
        'Choose a workspace for the workflow to run in.'
      )
    }
    const { definition, issues } = await this.validate(preset.definition)
    if (!definition || hasBlockingWorkflowIssues(issues)) {
      throw new WorkflowValidationError(issues)
    }
    const run = createWorkflowRunRecord({
      id: `wfr_${randomUUID()}`,
      presetId: preset.id,
      presetName: preset.name,
      objective: args.objective.trim() || preset.defaultRunSettings.objective,
      definition,
      placement: { worktreeSelector: args.worktreeSelector, worktreeLabel: args.worktreeLabel },
      at: this.now().toISOString()
    })
    for (const warning of issues) {
      appendWorkflowEvent(
        run,
        'warning',
        run.createdAt,
        warning.message,
        warning.nodeId ? { nodeId: warning.nodeId } : {}
      )
    }
    await this.store.saveRun(run)
    void launchWorkflowRun(this.session(run))
    return run
  }

  pause(id: string): Promise<void> {
    const session = this.liveSession(id)
    return session.exclusive(() => {
      session.run.schedulingPaused = true
      session.run.status = 'paused'
      appendWorkflowEvent(
        session.run,
        'run-paused',
        session.at(),
        'Scheduling paused. Running workers continue until they report.'
      )
      session.persist()
    })
  }

  async resume(id: string): Promise<void> {
    const session = this.liveSession(id)
    await session.exclusive(() => {
      session.run.schedulingPaused = false
      session.run.status = 'running'
      appendWorkflowEvent(session.run, 'run-resumed', session.at(), 'Scheduling resumed.')
      session.persist()
    })
    await session.schedule()
  }

  async cancel(id: string): Promise<void> {
    await cancelWorkflowRun(this.liveSession(id), 'Cancelled by the user.')
  }

  async retryTask(runId: string, taskKey: string): Promise<void> {
    const session = this.liveSession(runId, { reopenFailed: true })
    const reopened = session.terminal
    await stopRunningTaskForRetry(session, taskKey)
    const ok = await session.exclusive(() => {
      const retried = retryWorkflowTask(session.run, taskKey, session.at())
      session.persist()
      return retried
    })
    if (!ok) {
      throw new WorkflowRequestError(
        'task_not_retryable',
        'Only a failed, cancelled, or unknown current task can be retried.'
      )
    }
    if (reopened) {
      await launchWorkflowRun(session)
      return
    }
    await session.schedule()
  }

  async resolveApproval(
    runId: string,
    taskKey: string,
    resolution: 'approved' | 'rejected'
  ): Promise<void> {
    const session = this.liveSession(runId)
    const { run } = session
    const gateId = run.tasks[taskKey]?.approval?.gateId
    if (gateId && run.coordinatorTerminalHandle && run.orcaRunId) {
      await this.adapter
        .resolveGate({
          from: run.coordinatorTerminalHandle,
          orcaRunId: run.orcaRunId,
          gateId,
          resolution,
          requestId: `${run.id}:${taskKey}:gate-resolve`
        })
        .catch((error: unknown) => session.warn(`Orca gate resolution failed: ${String(error)}`))
    }
    const result = await session.exclusive(() => {
      const settled = resolveWorkflowApproval(run, taskKey, resolution, session.at())
      session.persist()
      return settled
    })
    if (result === 'stale') {
      throw new WorkflowRequestError('approval_not_pending', 'That approval is no longer pending.')
    }
    await session.schedule()
  }

  async releaseMessage(
    runId: string,
    messageId: string,
    decision: 'deliver' | 'drop'
  ): Promise<void> {
    const session = this.liveSession(runId)
    await session.exclusive(() => {
      releaseHeldWorkflowMessage(session, messageId, decision)
      session.persist()
    })
    await session.schedule()
  }

  async replyToQuestion(runId: string, messageId: string, body: string): Promise<void> {
    const run = this.requireRun(runId)
    const question = run.messages.find(
      (message) => message.id === messageId && message.type === 'question'
    )
    if (!question?.orcaMessageId || !run.coordinatorTerminalHandle || !run.orcaRunId) {
      throw new WorkflowRequestError(
        'question_not_found',
        'That question cannot be answered from here.'
      )
    }
    await this.adapter.reply({
      from: run.coordinatorTerminalHandle,
      orcaRunId: run.orcaRunId,
      messageId: question.orcaMessageId,
      body,
      requestId: `${run.id}:reply:${messageId}`
    })
    const session = this.session(run)
    await session.exclusive(() => {
      appendWorkflowEvent(
        run,
        'message-delivered',
        session.at(),
        `Answered: ${body.slice(0, 120)}`,
        { correlationId: question.correlationId }
      )
      session.persist()
    })
  }

  deleteRun(id: string): boolean {
    const run = this.requireRun(id)
    if (!isWorkflowRunTerminal(run.status)) {
      throw new WorkflowRequestError(
        'workflow_run_live',
        'Cancel the run before deleting its history.'
      )
    }
    this.sessions.get(id)?.close()
    this.sessions.delete(id)
    return this.store.deleteRun(id)
  }

  /** Resume every run that was live when Orca stopped. */
  async recoverAll(): Promise<void> {
    for (const run of this.store.listRuns()) {
      // A run this process already drives (started before recovery fired) is live, not interrupted.
      const live = this.sessions.get(run.id)
      if (isWorkflowRunTerminal(run.status) || (live && !live.isClosed)) {
        continue
      }
      const session = this.session(run)
      await (run.status === 'cancelling'
        ? cancelWorkflowRun(session, 'Cancellation resumed after restart.')
        : recoverWorkflowRun(session))
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.close()
    }
    this.store.flushSync()
  }
}
