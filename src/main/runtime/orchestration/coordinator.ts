/* eslint-disable max-lines -- Why: the coordinator keeps message processing, task dispatch, gate handling, escalation, and convergence checking in one class so the polling loop can make atomic decisions across all these concerns without split-brain behavior. */
import type { OrchestrationDb } from './db'
import type { MessageRow, TaskRow, CoordinatorStatus } from './types'
import { buildDispatchPreamble } from './preamble'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'

export type CoordinatorRuntime = {
  sendTerminalAgentPrompt(handle: string, prompt: string): Promise<unknown>
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
  // Why (§3.1): lives on the runtime because it must resolve a worktree, load the repo, and fetch — the coordinator only knows handles + specs.
  probeWorktreeDrift(worktreeSelector: string): Promise<{
    base: string
    behind: number
    recentSubjects: string[]
  } | null>
  // Why: optional so lightweight runtime fakes keep compiling; when present, dispatch records the assignee's remint-stable pane identity.
  getTerminalPaneKey?(handle: string): string | null
  // Why: Windows can host native and WSL workers at once, so the worker pane (not the coordinator) picks the packaged CLI name.
  getTerminalOrchestrationCliCommand?(handle: string): 'orca' | 'orca-ide'
}

// Why (§3.1): 20 lets normal monorepo day-velocity pass but trips the 168-commit harm from ORCHESTRATOR_FEEDBACK.md (chosen in msg_eff3a646110d).
export const DISPATCH_STALE_THRESHOLD = 20

// Why (§3.4): the flag lives in the spec text (no DB column in v1); the regex is narrow so typos fail closed, and stripping keeps the infra line out of the worker's `--- TASK ---` block.
// Trade-off (§7.9): matches any spec line, even inside fenced code — fails open, but the preamble drift section still surfaces staleness to the worker.
const ALLOW_STALE_BASE_RE = /^[ \t]*allow-stale-base:[ \t]*true[ \t]*\r?$/im
const ALLOW_STALE_BASE_STRIP_RE = /^[ \t]*allow-stale-base:[ \t]*true[ \t]*\r?\n?/im

export function parseAllowStaleBaseFromSpec(spec: string): {
  allowStale: boolean
  strippedSpec: string
} {
  if (!ALLOW_STALE_BASE_RE.test(spec)) {
    return { allowStale: false, strippedSpec: spec }
  }
  const strippedSpec = spec.replace(ALLOW_STALE_BASE_STRIP_RE, '')
  return { allowStale: true, strippedSpec }
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

// Why: 10 min = documented heartbeat cadence (5 min) × 2, so one missed heartbeat is the earliest a dispatch can look stale.
const HUNG_THRESHOLD_MS = 10 * 60 * 1000

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
    this.processDecisionGates()
    this.warnStaleDispatches()
    await this.dispatchReadyTasks()
    return this.checkConvergence()
  }

  // Why: warn only, never auto-fail — a false positive (slow but correct worker) costs more than a false negative (hung worker holding a slot); see R6 of DESIGN_DOC_PREAMBLE_FIX.md.
  private warnStaleDispatches(): void {
    const thresholdIso = new Date(Date.now() - HUNG_THRESHOLD_MS).toISOString()
    const stale = this.db.getStaleDispatches(thresholdIso)
    for (const ctx of stale) {
      const minutes = Math.round(HUNG_THRESHOLD_MS / 60000)
      this.opts.onLog(
        `Warning: worker ${ctx.assignee_handle ?? '<unknown>'} on task ${ctx.task_id} has not sent a heartbeat in ~${minutes} min (dispatch ${ctx.id})`
      )
    }
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
          this.handleDecisionGateMessage(msg)
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
    }
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

    // Why: fail the dispatch to increment the circuit breaker; under threshold the task returns to 'pending' for re-dispatch next tick.
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
    // Why: escalations are handled inline via handleEscalation; this stays a hook for future policies (auto-reassign, external notify).
  }

  private processDecisionGates(): void {
    // Why: the coordinator never auto-resolves gates (humans do, via orchestration.gateResolve) — that would defeat them as approval checkpoints.
    const pendingGates = this.db.listGates({ status: 'pending' })
    for (const gate of pendingGates) {
      const task = this.db.getTask(gate.task_id)
      if (task && task.status !== 'blocked') {
        // Why: gate exists but task isn't blocked — re-block to restore the invariant.
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

    const dispatched = this.db.listTasks({ status: 'dispatched' })
    let slotsAvailable = this.opts.maxConcurrent - dispatched.length
    if (slotsAvailable <= 0) {
      return
    }

    const terminals = await this.getAvailableTerminals()
    if (terminals.length === 0 && slotsAvailable > 0) {
      // Why: create at most one terminal per tick to avoid spawning many at once.
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
    // Why (§3.1): drift check runs before createDispatchContext so a refusal doesn't bump failure_count (carried forward as MAX in db.ts:301-306) and burn the circuit-breaker budget; the task stays `ready` and retries next tick.
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(task.spec)
    let baseDrift: {
      base: string
      behind: number
      recentSubjects: string[]
    } | null = null

    if (!this.opts.worktree) {
      // Why (§7.4): worktree is optional; with none we can't probe drift, so log that the guard is inert and proceed.
      this.opts.onLog(`stale-base guard inert for ${task.id}: coordinator has no worktree selector`)
    } else {
      baseDrift = await this.runtime.probeWorktreeDrift(this.opts.worktree).catch((err) => {
        this.opts.onLog(`probeWorktreeDrift failed for ${this.opts.worktree}: ${err}`)
        return null
      })

      if (baseDrift && baseDrift.behind > DISPATCH_STALE_THRESHOLD && !allowStale) {
        // Why (§3.1): silent-return, not failDispatch — failing a recoverable stale-base here would burn the circuit-breaker budget.
        this.opts.onLog(
          `Skipping dispatch of ${task.id}: worktree is ${baseDrift.behind} commits ` +
            `behind ${baseDrift.base}. Pull/rebase the worktree, recreate it with ` +
            `--base-branch ${baseDrift.base}, or include 'allow-stale-base: true' ` +
            `in the task spec to override. Task remains in 'ready'; coordinator ` +
            `will retry on the next tick.`
        )
        return
      }
    }

    const dispatch = this.db.createDispatchContext(
      task.id,
      targetHandle,
      this.runtime.getTerminalPaneKey?.(targetHandle) ?? undefined
    )

    // Why: dispatched agents use orca-dev in dev mode to reach the dev runtime's socket, not production (Section 6.4).
    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId: dispatch.id,
      // Why (§3.4): strippedSpec drops the allow-stale-base line so the worker doesn't read the infra flag as an instruction.
      taskSpec: strippedSpec,
      coordinatorHandle: this.opts.coordinatorHandle,
      workerHandle: targetHandle,
      devMode: process.env.ORCA_USER_DATA_PATH?.includes('orca-dev'),
      ...(this.runtime.getTerminalOrchestrationCliCommand
        ? { cliCommand: this.runtime.getTerminalOrchestrationCliCommand(targetHandle) }
        : {}),
      // Why (§3.2): pass baseDrift unconditionally — the preamble builder itself gates the drift section on behind > 0.
      ...(baseDrift ? { baseDrift } : {})
    })

    // Why: surface a since-resolved decision gate's outcome to the worker via the preamble.
    const gates = this.db.listGates({ taskId: task.id, status: 'resolved' })
    let gateContext = ''
    if (gates.length > 0) {
      const latest = gates.at(-1)!
      gateContext = `\n\n--- DECISION GATE RESOLVED ---\nQuestion: ${latest.question}\nResolution: ${latest.resolution}\n---\n`
    }

    try {
      await this.runtime.sendTerminalAgentPrompt(targetHandle, preamble + gateContext)
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

      // Why: createDispatchContext's dispatch-lock guarantees correctness; this filter is only an optimization to skip busy/disconnected terminals.
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

    // Why: no active tasks but some blocked → dependencies can never be satisfied (stuck).
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
