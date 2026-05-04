/* eslint-disable max-lines -- Why: the coordinator keeps message processing, task dispatch, gate handling, escalation, and convergence checking in one class so the polling loop can make atomic decisions across all these concerns without split-brain behavior. */
import type { OrchestrationDb } from './db'
import type { MessageRow, TaskRow, CoordinatorStatus } from './types'
import { buildDispatchPreamble } from './preamble'

export type CoordinatorRuntime = {
  sendTerminal(handle: string, action: { text?: string; enter?: boolean }): Promise<unknown>
  listTerminals(
    worktreeSelector?: string,
    limit?: number
  ): Promise<{
    terminals: { handle: string; worktreeId: string; connected: boolean; writable: boolean }[]
  }>
  createTerminal(
    worktreeSelector?: string,
    opts?: { command?: string; title?: string }
  ): Promise<{ handle: string; worktreeId: string }>
  waitForTerminal(
    handle: string,
    options?: { condition?: string; timeoutMs?: number }
  ): Promise<{ handle: string; condition: string }>
}

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

  // Why: the RPC handler creates the coordinator_runs record itself so it can
  // return the run ID immediately, then starts the loop in the background.
  // This method skips the DB insert and uses the pre-created run ID.
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

      // Why: if stopped early, treat it as failed since tasks are incomplete.
      // Also failed if any task explicitly failed.
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

  // Why: the coordinator decomposes the top-level spec into a task DAG.
  // For now, tasks must be pre-created before calling run(). The spec is
  // stored for context but decomposition is the caller's responsibility —
  // AI-driven decomposition belongs in a future phase where the coordinator
  // itself is an LLM agent.
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
    this.processDecisionGates()
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
          this.handleWorkerDone(msg)
          break
        case 'escalation':
          this.handleEscalation(msg)
          break
        case 'decision_gate':
          this.handleDecisionGateMessage(msg)
          break
        case 'status':
          this.opts.onLog(`Status from ${msg.from_handle}: ${msg.subject}`)
          break
        default:
          break
      }
    }

    this.db.markAsRead(messages.map((m) => m.id))
  }

  private handleWorkerDone(msg: MessageRow): void {
    this.opts.onLog(`Worker done: ${msg.from_handle} — ${msg.subject}`)

    let payload: { taskId?: string; filesModified?: string[] } = {}
    if (msg.payload) {
      try {
        payload = JSON.parse(msg.payload)
      } catch {
        this.opts.onLog(`Warning: invalid payload in worker_done from ${msg.from_handle}`)
      }
    }

    const taskId = payload.taskId
    if (!taskId) {
      this.opts.onLog(`Warning: worker_done without taskId from ${msg.from_handle}`)
      return
    }

    const task = this.db.getTask(taskId)
    if (!task) {
      this.opts.onLog(`Warning: worker_done for unknown task ${taskId}`)
      return
    }

    const result = JSON.stringify({
      completedBy: msg.from_handle,
      filesModified: payload.filesModified ?? [],
      completedAt: new Date().toISOString()
    })
    this.db.updateTaskStatus(taskId, 'completed', result)
    this.state.completedTasks.push(taskId)

    // Why: complete the dispatch context so the terminal is freed for
    // subsequent task assignments.
    const dispatch = this.db.getDispatchContext(taskId)
    if (dispatch) {
      this.db.completeDispatch(dispatch.id)
    }

    this.opts.onLog(`Task ${taskId} completed`)
  }

  private handleEscalation(msg: MessageRow): void {
    this.opts.onLog(`Escalation from ${msg.from_handle}: ${msg.subject}`)
    this.state.escalations.push(msg)

    let taskId: string | undefined
    if (msg.payload) {
      try {
        const payload = JSON.parse(msg.payload)
        taskId = payload.taskId
      } catch {
        // Escalation without structured payload — log subject as context
      }
    }

    if (!taskId) {
      return
    }

    const task = this.db.getTask(taskId)
    if (!task || task.status === 'completed' || task.status === 'failed') {
      return
    }

    const dispatch = this.db.getDispatchContext(taskId)
    if (!dispatch) {
      return
    }

    // Why: fail the dispatch so the circuit breaker increments. If under
    // the threshold, the task returns to 'pending' and will be re-dispatched
    // to a (potentially different) terminal on the next tick.
    const updated = this.db.failDispatch(dispatch.id, msg.subject)
    if (updated?.status === 'circuit_broken') {
      this.opts.onLog(`Task ${taskId} circuit broken after repeated failures`)
      this.db.updateTaskStatus(taskId, 'failed', `Circuit broken: ${msg.subject}`)
      this.state.failedTasks.push(taskId)
    } else {
      this.opts.onLog(`Task ${taskId} will be retried (failure ${updated?.failure_count ?? 0}/3)`)
    }
  }

  private handleDecisionGateMessage(msg: MessageRow): void {
    this.opts.onLog(`Decision gate from ${msg.from_handle}: ${msg.subject}`)

    let payload: { taskId?: string; question?: string; options?: string[] } = {}
    if (msg.payload) {
      try {
        payload = JSON.parse(msg.payload)
      } catch {
        return
      }
    }

    if (!payload.taskId || !payload.question) {
      this.opts.onLog(`Warning: decision_gate missing taskId or question`)
      return
    }

    this.db.createGate({
      taskId: payload.taskId,
      question: payload.question,
      options: payload.options
    })

    this.opts.onLog(`Task ${payload.taskId} blocked on decision gate`)
  }

  private processEscalations(): void {
    // Why: escalation processing is handled inline in processMessages via
    // handleEscalation. This method exists as a hook for future escalation
    // policies (e.g., auto-reassign after N minutes, notify external systems).
  }

  private processDecisionGates(): void {
    // Why: pending gates that haven't been resolved externally are surfaced
    // here. In production, the coordinator UI or a human operator resolves
    // gates via orchestration.gateResolve. The coordinator does not auto-
    // resolve gates — that would defeat their purpose as approval checkpoints.
    const pendingGates = this.db.listGates({ status: 'pending' })
    for (const gate of pendingGates) {
      const task = this.db.getTask(gate.task_id)
      if (task && task.status !== 'blocked') {
        // Why: gate exists but task isn't blocked — inconsistent state.
        // Re-block the task to maintain the invariant.
        this.db.updateTaskStatus(gate.task_id, 'blocked')
      }
    }
  }

  private async dispatchReadyTasks(): Promise<void> {
    this.state.phase = 'dispatching'
    const readyTasks = this.db.listTasks({ ready: true })
    if (readyTasks.length === 0) {
      return
    }

    // Why: count currently dispatched tasks to enforce concurrency limit.
    const dispatched = this.db.listTasks({ status: 'dispatched' })
    let slotsAvailable = this.opts.maxConcurrent - dispatched.length
    if (slotsAvailable <= 0) {
      return
    }

    const terminals = await this.getAvailableTerminals()
    if (terminals.length === 0 && slotsAvailable > 0) {
      // Why: no idle terminals exist — create one for the next task.
      // Only create one per tick to avoid spawning many terminals at once.
      try {
        const created = await this.runtime.createTerminal(this.opts.worktree, {
          title: `Worker: ${readyTasks[0].spec.slice(0, 40)}`
        })
        terminals.push(created.handle)
        this.opts.onLog(`Created worker terminal ${created.handle}`)
      } catch (err) {
        this.opts.onLog(`Failed to create terminal: ${err}`)
        return
      }
    }

    for (const task of readyTasks) {
      if (slotsAvailable <= 0 || terminals.length === 0) {
        break
      }

      const targetHandle = terminals.shift()!
      slotsAvailable--

      try {
        await this.dispatchTask(task, targetHandle)
      } catch (err) {
        this.opts.onLog(`Failed to dispatch task ${task.id}: ${err}`)
      }
    }
  }

  private async dispatchTask(task: TaskRow, targetHandle: string): Promise<void> {
    const dispatch = this.db.createDispatchContext(task.id, targetHandle)

    // Why: agents dispatched by the coordinator must use orca-dev in dev mode
    // so they talk to the dev runtime's socket, not production (Section 6.4).
    const preamble = buildDispatchPreamble({
      taskId: task.id,
      taskSpec: task.spec,
      coordinatorHandle: this.opts.coordinatorHandle,
      devMode: process.env.ORCA_USER_DATA_PATH?.includes('orca-dev')
    })

    // Why: check if the task was previously blocked by a decision gate that
    // has since been resolved. Include the resolution in the preamble so the
    // worker knows the decision outcome.
    const gates = this.db.listGates({ taskId: task.id, status: 'resolved' })
    let gateContext = ''
    if (gates.length > 0) {
      const latest = gates.at(-1)!
      gateContext = `\n\n--- DECISION GATE RESOLVED ---\nQuestion: ${latest.question}\nResolution: ${latest.resolution}\n---\n`
    }

    try {
      await this.runtime.sendTerminal(targetHandle, {
        text: preamble + gateContext,
        enter: true
      })
    } catch (err) {
      const updated = this.db.failDispatch(
        dispatch.id,
        err instanceof Error ? err.message : String(err)
      )
      if (updated?.status === 'circuit_broken') {
        this.state.failedTasks.push(task.id)
      }
      throw err
    }

    this.opts.onLog(`Dispatched task ${task.id} to ${targetHandle}`)
    this.state.phase = 'monitoring'
  }

  private async getAvailableTerminals(): Promise<string[]> {
    try {
      const result = await this.runtime.listTerminals(this.opts.worktree)
      const dispatched = this.db.listTasks({ status: 'dispatched' })
      const busyHandles = new Set<string>()

      for (const task of dispatched) {
        const ctx = this.db.getDispatchContext(task.id)
        if (ctx?.assignee_handle) {
          busyHandles.add(ctx.assignee_handle)
        }
      }

      // Why: exclude the coordinator's own terminal, terminals with active
      // dispatches, and disconnected terminals. The dispatch-lock in
      // createDispatchContext prevents double-dispatch even if a terminal
      // looks available here — this filter is an optimization, not a
      // correctness constraint.
      return result.terminals
        .filter(
          (t) =>
            t.handle !== this.opts.coordinatorHandle &&
            !busyHandles.has(t.handle) &&
            t.connected &&
            t.writable
        )
        .map((t) => t.handle)
    } catch {
      return []
    }
  }

  private checkConvergence(): boolean {
    const tasks = this.db.listTasks()
    if (tasks.length === 0) {
      return true
    }

    const allDone = tasks.every((t) => t.status === 'completed' || t.status === 'failed')
    if (allDone) {
      this.state.phase = 'done'
      return true
    }

    // Why: detect stuck state — no ready or dispatched tasks, but some are
    // still pending/blocked. This means deps can never be satisfied.
    const active = tasks.filter(
      (t) => t.status === 'ready' || t.status === 'dispatched' || t.status === 'pending'
    )
    const blocked = tasks.filter((t) => t.status === 'blocked')
    if (active.length === 0 && blocked.length > 0) {
      this.opts.onLog(
        `Stuck: ${blocked.length} tasks blocked with no active tasks. Resolve decision gates to continue.`
      )
    }

    return false
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  }
}
