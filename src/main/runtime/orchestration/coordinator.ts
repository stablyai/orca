import type { OrchestrationDb } from './db'
import type { MessageRow, CoordinatorStatus } from './types'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'
import type { CoordinatorRuntime, WorktreeDrift } from './coordinator-runtime-contract'
import { applyEscalationToDispatch } from './coordinator-escalation-triage'
import { evaluateDagConvergence } from './coordinator-dag-convergence'
import {
  openDecisionGateFromMessage,
  reblockTasksWithPendingGates
} from './coordinator-decision-gates'
import {
  dispatchTaskToWorker,
  listAvailableWorkerTerminals,
  warnStaleDispatches
} from './coordinator-task-dispatch'

export type CoordinatorOptions = {
  spec: string
  coordinatorHandle: string
  pollIntervalMs?: number
  maxConcurrent?: number
  worktree?: string
  onLog?: (msg: string) => void
}

type CoordinatorState = {
  runId: string
  phase: 'decomposing' | 'dispatching' | 'monitoring' | 'merging' | 'done'
  completedTasks: string[]
  failedTasks: string[]
  escalations: MessageRow[]
}

const DEFAULT_POLL_MS = 2000
const MAX_CONCURRENT_DEFAULT = 4

export class Coordinator {
  private db: OrchestrationDb
  private runtime: CoordinatorRuntime
  private state: CoordinatorState
  private stopped = false
  private opts: Required<Omit<CoordinatorOptions, 'onLog' | 'worktree'>> & {
    onLog: (msg: string) => void
    worktree?: string
  }

  constructor(db: OrchestrationDb, runtime: CoordinatorRuntime, options: CoordinatorOptions) {
    this.db = db
    this.runtime = runtime
    this.opts = {
      spec: options.spec,
      coordinatorHandle: options.coordinatorHandle,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_MS,
      maxConcurrent: options.maxConcurrent ?? MAX_CONCURRENT_DEFAULT,
      worktree: options.worktree,
      onLog: options.onLog ?? (() => {})
    }
    this.state = {
      runId: '',
      phase: 'decomposing',
      completedTasks: [],
      failedTasks: [],
      escalations: []
    }
  }

  async run(): Promise<{
    runId: string
    status: CoordinatorStatus
    completedTasks: string[]
    failedTasks: string[]
    escalations: MessageRow[]
  }> {
    const run = this.db.createCoordinatorRun({
      spec: this.opts.spec,
      coordinatorHandle: this.opts.coordinatorHandle,
      pollIntervalMs: this.opts.pollIntervalMs
    })
    return this.executeLoop(run.id)
  }

  // Why: the RPC handler pre-creates the run record to return the ID immediately, so this method skips the DB insert.
  async runFromExistingRun(runId: string): Promise<{
    runId: string
    status: CoordinatorStatus
    completedTasks: string[]
    failedTasks: string[]
    escalations: MessageRow[]
  }> {
    return this.executeLoop(runId)
  }

  private async executeLoop(runId: string): Promise<{
    runId: string
    status: CoordinatorStatus
    completedTasks: string[]
    failedTasks: string[]
    escalations: MessageRow[]
  }> {
    this.state.runId = runId
    this.opts.onLog(`Coordinator run ${runId} started`)

    try {
      await this.decompose()

      while (!this.stopped) {
        const converged = await this.tick()
        if (converged) {
          break
        }
        await this.sleep(this.opts.pollIntervalMs)
      }

      // Why: an early stop leaves tasks incomplete, so the run counts as failed.
      const tasks = this.db.listTasks()
      const allDone = tasks.every((t) => t.status === 'completed' || t.status === 'failed')
      const failedTasks = [
        ...new Set([
          ...this.state.failedTasks,
          ...tasks.filter((task) => task.status === 'failed').map((task) => task.id)
        ])
      ]
      const finalStatus =
        this.stopped || failedTasks.length > 0 || !allDone ? 'failed' : 'completed'
      this.db.updateCoordinatorRun(runId, finalStatus)
      this.opts.onLog(`Coordinator run ${runId} ${finalStatus}`)

      return {
        runId,
        status: finalStatus,
        completedTasks: this.state.completedTasks,
        failedTasks,
        escalations: this.state.escalations
      }
    } catch (err) {
      this.db.updateCoordinatorRun(runId, 'failed')
      throw err
    }
  }

  stop(): void {
    this.stopped = true
  }

  // Why: decomposition isn't implemented yet — tasks must be pre-created before run(); AI-driven decomposition is a future phase.
  private async decompose(): Promise<void> {
    this.state.phase = 'decomposing'
    const existing = this.db.listTasks()
    if (existing.length === 0) {
      throw new Error(
        'No tasks found. Create tasks with orchestration.taskCreate before running the coordinator.'
      )
    }
    this.opts.onLog(`Found ${existing.length} tasks in DAG`)
    this.state.phase = 'dispatching'
  }

  private async tick(): Promise<boolean> {
    this.processMessages()
    this.processEscalations()
    reblockTasksWithPendingGates(this.db)
    warnStaleDispatches(this.db, this.opts.onLog)
    await this.dispatchReadyTasks()
    return this.checkConvergence()
  }

  private processMessages(): void {
    const messages = this.db.getUnreadMessages(this.opts.coordinatorHandle)
    if (messages.length === 0) {
      return
    }

    for (const msg of messages) {
      switch (msg.type) {
        case 'worker_done':
          this.handleLifecycleMessage(msg)
          break
        case 'escalation':
          this.handleEscalation(msg)
          break
        case 'decision_gate':
          openDecisionGateFromMessage(this.db, msg, this.opts.onLog)
          break
        case 'heartbeat':
          this.handleLifecycleMessage(msg)
          break
        case 'status':
          this.opts.onLog(`Status from ${msg.from_handle}: ${msg.subject}`)
          break
        case 'dispatch':
        case 'handoff':
        case 'merge_ready':
        case 'question':
          break
      }
    }

    this.db.markAsRead(messages.map((m) => m.id))
  }

  private handleLifecycleMessage(msg: MessageRow): void {
    const result = reconcileLifecycleMessage(this.db, msg, this.opts.onLog)
    if (result.action === 'completed') {
      if (!this.state.completedTasks.includes(result.taskId)) {
        this.state.completedTasks.push(result.taskId)
      }
      return
    }
    if (result.action === 'failed' && !this.state.failedTasks.includes(result.taskId)) {
      this.state.failedTasks.push(result.taskId)
    }
  }

  private handleEscalation(msg: MessageRow): void {
    this.opts.onLog(`Escalation from ${msg.from_handle}: ${msg.subject}`)
    this.state.escalations.push(msg)

    const circuitBrokenTaskId = applyEscalationToDispatch(this.db, msg, this.opts.onLog)
    if (circuitBrokenTaskId) {
      this.state.failedTasks.push(circuitBrokenTaskId)
    }
  }

  private processEscalations(): void {
    // Why: escalations are handled inline via handleEscalation; this stays a hook for future policies (auto-reassign, external notify).
  }

  private async dispatchReadyTasks(): Promise<void> {
    this.state.phase = 'dispatching'
    const readyTasks = this.db.listTasks({ ready: true })
    if (readyTasks.length === 0) {
      return
    }

    const dispatched = this.db.listTasks({ status: 'dispatched' })
    let slotsAvailable = this.opts.maxConcurrent - dispatched.length
    if (slotsAvailable <= 0) {
      return
    }

    const terminals = await listAvailableWorkerTerminals(
      this.db,
      this.runtime,
      this.opts.coordinatorHandle,
      this.opts.worktree
    )
    if (terminals.length === 0 && slotsAvailable > 0) {
      // Why: create at most one terminal per tick to avoid spawning many at once.
      try {
        const created = await this.runtime.createTerminal(this.opts.worktree, {
          title: `Worker: ${readyTasks[0].spec.slice(0, 40)}`
        })
        terminals.push(created.handle)
        this.opts.onLog(`Created worker terminal ${created.handle}`)
      } catch (err) {
        this.opts.onLog(`Failed to create terminal: ${String(err)}`)
        return
      }
    }

    // Why: every task in one tick dispatches from the same fetched base snapshot.
    const baseDrift: WorktreeDrift = this.opts.worktree
      ? await this.runtime.probeWorktreeDrift(this.opts.worktree).catch((err) => {
          this.opts.onLog(`probeWorktreeDrift failed for ${this.opts.worktree}: ${err}`)
          return null
        })
      : null

    for (const task of readyTasks) {
      if (slotsAvailable <= 0 || terminals.length === 0) {
        break
      }

      const targetHandle = terminals.shift()!
      slotsAvailable--

      try {
        const result = await dispatchTaskToWorker({
          db: this.db,
          runtime: this.runtime,
          task,
          targetHandle,
          baseDrift,
          coordinatorHandle: this.opts.coordinatorHandle,
          worktree: this.opts.worktree,
          onLog: this.opts.onLog,
          onCircuitBroken: (taskId) => this.state.failedTasks.push(taskId)
        })
        if (result === 'stale-base-refused') {
          terminals.unshift(targetHandle)
          slotsAvailable++
        } else {
          this.state.phase = 'monitoring'
        }
      } catch (err) {
        this.opts.onLog(`Failed to dispatch task ${task.id}: ${String(err)}`)
      }
    }
  }

  private checkConvergence(): boolean {
    const convergence = evaluateDagConvergence(this.db, this.opts.onLog)
    if (convergence === 'all-done') {
      this.state.phase = 'done'
    }
    return convergence !== 'active'
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }
}
