/* eslint-disable max-lines -- Why: the coordinator keeps message processing, task dispatch, gate handling, escalation, and convergence checking in one class so the polling loop can make atomic decisions across all these concerns without split-brain behavior. */
import type { TuiAgent } from '../../../shared/types'
import type { OrchestrationDb } from './db'
import type { MessageRow, TaskRow, CoordinatorStatus } from './types'
import { buildDispatchPreamble } from './preamble'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'

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
  // Why (round 3, must-fix #1): the REAL agent spawn. createTerminal only spawns
  // its `command` (a plain shell when unset) and treats `launchAgent` as a mere
  // metadata tag — it does NOT run an agent. launchAgentTerminal builds the actual
  // agent launch command (buildStartupForAgent) and spawns it. The coordinator
  // uses THIS to relaunch a worker agent in an EXISTING track worktree when the
  // cached terminal is gone, so the dispatch preamble never lands in a bare shell.
  // OPTIONAL/additive: a runtime without it cannot relaunch an agent, and the
  // coordinator refuses to downgrade to a shell (breaker-accounts instead).
  launchAgentTerminal?(
    worktreeSelector: string,
    opts: { agent: TuiAgent; prompt: string; title?: string }
  ): Promise<{ handle: string; worktreeId: string }>
  waitForTerminal(
    handle: string,
    options?: { condition?: string; timeoutMs?: number }
  ): Promise<{ handle: string; condition: string }>
  // Why (§3.1): dispatch pre-flight drift check lives on the runtime because
  // it needs to resolve a worktree selector, load the repo, and fetch. The
  // coordinator only knows about handles + specs; resolving a git worktree
  // from this layer would leak transport details here.
  probeWorktreeDrift(worktreeSelector: string): Promise<{
    base: string
    behind: number
    recentSubjects: string[]
  } | null>
  // Why (F2 #13): create a child worktree whose lineage parent is the director
  // worktree, so coordinator-driven work becomes visible in Mission Control
  // (selectSpawnedWorktreeIds keys on parentWorktreeId === directorWorktreeId).
  // OPTIONAL so existing implementers (the test mock, other runtimes) keep
  // compiling and the legacy bare-terminal dispatch path is unaffected when a
  // runtime doesn't provide it. Thin adapter over OrcaRuntimeService.createManagedWorktree.
  createWorktree?(opts: {
    parentWorktree: string
    name: string
    baseBranch?: string
    orchestrationRunId?: string
    taskId?: string
    coordinatorHandle?: string
    startup?: { agent: TuiAgent; prompt?: string }
  }): Promise<{ worktreeId: string; branch: string; terminalHandle?: string }>
  // Why (F2 #13, round 2): tear down a just-created child worktree when a
  // post-create dispatch step fails, so repeated failures don't accumulate
  // orphan worktrees. OPTIONAL for the same additive reason as createWorktree.
  removeWorktree?(worktreeId: string): Promise<void>
}

// Why (§3.1): single threshold, no warn/refuse split. Coordinator picked 20
// in msg_eff3a646110d — lets normal day-of-velocity on active monorepos pass
// while still tripping on the 168-commit harm observed in ORCHESTRATOR_FEEDBACK.md.
export const DISPATCH_STALE_THRESHOLD = 20

// Why (§3.4): the flag is stashed in the task spec text rather than a DB
// column in v1. The regex is intentionally narrow — only the canonical form
// matches, so typos fail closed (dispatch refuses). Returning the stripped
// spec alongside the boolean keeps this infra line out of the worker's
// `--- TASK ---` block (workers would otherwise read it as an instruction).
//
// Trade-off (§7.9): the regex matches any line of the spec including lines
// inside fenced code blocks. Acceptable v1 limitation — the failure mode is
// "dispatches through when the author didn't intend to," which the preamble
// drift section surfaces to the worker. Skill doc directs authors to place
// the flag as the last line and avoid the literal flag in code examples.
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

// Why (F2 #13, slice 2 / design §3.3): a task declares its track in spec text via
// `track: <key>` — the same low-friction channel as `allow-stale-base`. Same-track
// tasks share one worktree/branch/PR (the implement→review handoff). The capture is
// a single non-whitespace token; createManagedWorktree sanitizes anything used in a
// branch name downstream. Like the stale-base flag, the line is STRIPPED from the
// worker's `--- TASK ---` block (workers would otherwise read it as an instruction).
// Returns null when unset; the caller defaults to the task's own id (→ per-task,
// the collision-free slice-1 behavior).
//
// Why (round 2, should-fix #3): `track:` is prose-likely, so — unlike F1's
// stale-base flag — we scan line-by-line and SKIP fenced code blocks (``` / ~~~).
// A `track:` line inside a worker-instruction example must not be parsed as the
// real key (which would mis-route the track AND corrupt the preamble by stripping
// an example line). Only the first non-fenced `track:` line on its own line wins.
// Safe degradation (round 3 nit): an unclosed/mismatched fence leaves `inFence`
// set, so the rest of the spec is skipped and no key is found → returns null →
// the caller defaults to the task id (per-task, collision-free), never a wrong key.
const TRACK_LINE_RE = /^[ \t]*track:[ \t]*(\S+)[ \t]*\r?$/i
const CODE_FENCE_RE = /^[ \t]*(?:```|~~~)/

export function parseTrackFromSpec(spec: string): {
  trackKey: string | null
  strippedSpec: string
} {
  const lines = spec.split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (CODE_FENCE_RE.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      continue
    }
    const match = lines[i].match(TRACK_LINE_RE)
    if (!match) {
      continue
    }
    // Strip the matched line, folding one newline exactly as a regex
    // `^track:...\r?\n?` strip would: drop the line plus its FOLLOWING newline; if
    // it is the last line, the PRECEDING newline stays (keeps prior strip semantics).
    const strippedSpec =
      i < lines.length - 1
        ? [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n')
        : lines.slice(0, i).join('\n') + (i > 0 ? '\n' : '')
    return { trackKey: match[1], strippedSpec }
  }
  return { trackKey: null, strippedSpec: spec }
}

// Why (F2 #13): a deterministic, branch-safe worktree name (Orca: worktree name
// IS branch name) per task. A readable slug from the task title/spec aids the
// Mission Control display; the unique task-id suffix prevents collisions when
// two tasks share a first line. createManagedWorktree further sanitizes and
// resolves any residual branch conflict. The per-run namespacing / track-based
// naming from design §6 is slice 2.
export function worktreeNameForTask(task: Pick<TaskRow, 'id' | 'spec' | 'task_title'>): string {
  const source = (task.task_title ?? task.spec).split('\n')[0] ?? ''
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  const shortTask = task.id.replace(/^task_/, '')
  return slug ? `orch-${slug}-${shortTask}` : `orch-${shortTask}`
}

export type CoordinatorOptions = {
  spec: string
  coordinatorHandle: string
  pollIntervalMs?: number
  maxConcurrent?: number
  worktree?: string
  // Why (F2 #13): opt-in, default OFF. When off the coordinator dispatches to
  // bare terminals in `worktree` exactly as before (byte-for-byte legacy path).
  // When on, each ready task gets its own lineage-visible child worktree so the
  // run shows up in Mission Control. Requires `worktree` (the director / lineage
  // parent) and a runtime that implements `createWorktree`.
  worktreeBacked?: boolean
  // Why (F2 #13): agent launched inside each track worktree via the startup
  // option; the dispatch preamble is then sent unchanged (design Q3 leaning).
  // When unset, a plain terminal is created in the worktree instead — the
  // lineage bridge still works; agent selection is deferred.
  workerAgent?: TuiAgent
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

// Why: 10 min matches the preamble's documented heartbeat cadence (5 min) ×
// 2, so a single missed heartbeat is the earliest a dispatch can look stale.
// Keeping this in one place (not a per-call arg) ensures the preamble copy
// and the detector logic stay aligned; moving it to a config would multiply
// the places this constant must be kept in sync.
const HUNG_THRESHOLD_MS = 10 * 60 * 1000

// Why (F2 #13, round 2): the worktree-backed path launches the worker agent and
// must not fire the preamble into a still-booting TUI (keystrokes get dropped).
// We wait for the agent terminal to reach tui-idle before sending. 60s is a
// generous-but-bounded ceiling for agent boot; on timeout the dispatch is
// failed through the circuit breaker (not retried forever) so a worker that
// never comes up gives up after the usual strikes.
const DISPATCH_READINESS_TIMEOUT_MS = 60 * 1000

type DriftResult = {
  base: string
  behind: number
  recentSubjects: string[]
} | null

// Why (F2 #13, round 3): the resolved stale-base pre-flight. `skip` means the
// base is too far behind and dispatch should be refused (recoverable, no breaker
// burn); `baseDrift` (when behind > 0 but under threshold) is threaded into the
// preamble; `strippedSpec` drops the `allow-stale-base` infra line. Computing it
// ONCE — before createWorktree in worktree-backed mode — lets a stale base skip
// without first creating (then tearing down) a worktree.
type DispatchDrift = {
  skip: boolean
  baseDrift: DriftResult
  strippedSpec: string
}

export class Coordinator {
  private db: OrchestrationDb
  private runtime: CoordinatorRuntime
  private state: CoordinatorState
  private stopped = false
  // Why (F2 #13, round 2): log the worktreeBacked→legacy downgrade exactly once
  // so an operator who asked for worktree-backed dispatch sees the signal
  // without a per-tick warning storm.
  private warnedMissingCreateWorktree = false
  // Why (F2 #13, slice 2 / design §3.3): the in-memory track map for this run.
  // First dispatch of a track lazily creates a worktree (the miss path) and caches
  // it here; later same-track tasks reuse it (the hit path) so review continues
  // implement's branch (one PR). Keyed by trackKey (spec hint → default = task id).
  // On resume-on-boot (#14) this map is pre-seeded via seedAdoptedTrackWorktrees so
  // a restarted run re-adopts its existing track worktrees (design §8) instead of
  // recreating them.
  private trackWorktrees = new Map<
    string,
    { worktreeId: string; terminalHandle: string; isAgent: boolean }
  >()
  private opts: Required<Omit<CoordinatorOptions, 'onLog' | 'worktree' | 'workerAgent'>> & {
    onLog: (msg: string) => void
    worktree?: string
    workerAgent?: TuiAgent
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
      worktreeBacked: options.worktreeBacked ?? false,
      workerAgent: options.workerAgent,
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

  // Why (F3 #14, design §8): resume-on-boot re-adopts a crashed run's existing
  // track worktrees instead of recreating them. The boot reconciler discovers the
  // director's lineage children (parentWorktreeId === directorWorktreeId, same
  // run) — the SAME data Mission Control uses — and seeds them here BEFORE the
  // loop starts. A re-adopted track is then a hit (dispatchIntoExistingTrack):
  // its cached terminal handle is a post-restart sentinel that won't match a live
  // terminal, so resolveTrackTerminal relaunches the worker agent IN the existing
  // checkout (preserving the predecessor's commits) rather than forking a new
  // worktree/branch. Must be called before run/runFromExistingRun.
  seedAdoptedTrackWorktrees(
    entries: Iterable<[string, { worktreeId: string; terminalHandle: string; isAgent: boolean }]>
  ): void {
    for (const [trackKey, track] of entries) {
      this.trackWorktrees.set(trackKey, track)
    }
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
      // Why (#12): tasks are created via orchestration.taskCreate before the run
      // exists, so they start unowned. Claim them for this run before decompose
      // reads the (now run-scoped) DAG — but only tasks on THIS run's target, so
      // a concurrent run on another target can't have its tasks poached.
      // Why (F3 #14): this MUST stay inside the try. On a resumed run a throw here
      // (e.g. a transient DB error) would otherwise reject the loop promise WITHOUT
      // finalizing the run — leaving it status='running' with no live loop, the
      // exact zombie F3 exists to prevent. Routing it through the catch marks the
      // run failed so the guard unblocks.
      const targetKey = this.db.getCoordinatorRun(runId)?.target_key ?? null
      this.db.adoptUnownedTasks(runId, targetKey)

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
      const tasks = this.db.listTasks({ coordinatorRunId: this.state.runId })
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
    const existing = this.db.listTasks({ coordinatorRunId: this.state.runId })
    if (existing.length === 0) {
      throw new Error(
        'No tasks found. Create tasks with orchestration.taskCreate before running the coordinator.'
      )
    }
    // Why (round 3, should-fix #3): same-track tasks share ONE worktree, so they
    // must be totally ordered — otherwise two of them can be `ready` at once and
    // the dispatch loop picks an arbitrary one (id is random, not insertion order),
    // letting `review` run before `implement` into an empty branch. We refuse to
    // run an unsafe DAG up front rather than relying on the operator remembering
    // deps. Only worktree-backed runs care (legacy dispatch shares no worktree).
    if (this.opts.worktreeBacked) {
      this.assertTrackOrderingSafe(existing)
    }
    this.opts.onLog(`Found ${existing.length} tasks in DAG`)
    this.state.phase = 'dispatching'
  }

  // Why (round 3, should-fix #3): a track = one shared worktree, so its tasks must
  // form a dependency chain (a total order). If two tasks on the same track are
  // not ordered by deps, they could be simultaneously `ready` and race into the
  // shared checkout (the canonical implement+review-without-deps bug). Refuse the
  // run with an actionable error instead of shipping correctness that hinges on
  // unenforced operator discipline. Throws (decompose's caller marks the run
  // failed) — safe by default: nothing is dispatched.
  private assertTrackOrderingSafe(tasks: TaskRow[]): void {
    const byTrack = new Map<string, TaskRow[]>()
    for (const task of tasks) {
      const key = this.trackKeyForTask(task)
      const group = byTrack.get(key)
      if (group) {
        group.push(task)
      } else {
        byTrack.set(key, [task])
      }
    }

    const taskIds = new Set(tasks.map((t) => t.id))
    const directDeps = new Map<string, string[]>()
    for (const task of tasks) {
      directDeps.set(task.id, this.parseDeps(task))
    }
    // a depends (transitively) on b?
    const dependsOn = (a: string, b: string): boolean => {
      const seen = new Set<string>()
      const stack = [...(directDeps.get(a) ?? [])]
      while (stack.length > 0) {
        const next = stack.pop()!
        if (next === b) {
          return true
        }
        if (seen.has(next) || !taskIds.has(next)) {
          continue
        }
        seen.add(next)
        stack.push(...(directDeps.get(next) ?? []))
      }
      return false
    }

    for (const [trackKey, group] of byTrack) {
      if (group.length < 2) {
        continue
      }
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]
          const b = group[j]
          if (!dependsOn(a.id, b.id) && !dependsOn(b.id, a.id)) {
            throw new Error(
              `Track '${trackKey}' has unordered tasks ${a.id} and ${b.id}: same-track tasks ` +
                `share one worktree and must be totally ordered. Declare a dependency between ` +
                `them (e.g. the review task should carry deps:[<implement task id>]) so they ` +
                `serialize in order. Refusing to run to avoid reviewing an empty branch.`
            )
          }
        }
      }
    }
  }

  // Why (round 3): task.deps is a JSON array of task ids; parse defensively so a
  // malformed value degrades to "no deps" instead of throwing mid-validation.
  private parseDeps(task: Pick<TaskRow, 'deps'>): string[] {
    try {
      const parsed = JSON.parse(task.deps)
      return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : []
    } catch {
      return []
    }
  }

  private async tick(): Promise<boolean> {
    this.processMessages()
    this.processEscalations()
    this.processDecisionGates()
    this.warnStaleDispatches()
    await this.dispatchReadyTasks()
    return this.checkConvergence()
  }

  // Why: emit a single warning per stale dispatch per tick. This intentionally
  // does NOT auto-fail the dispatch — the false-positive cost (a slow worker
  // producing correct output) is higher than the false-negative cost (a hung
  // worker keeps its terminal slot until a human notices). Auto-fail policy
  // is a separate decision documented in R6 of DESIGN_DOC_PREAMBLE_FIX.md.
  private warnStaleDispatches(): void {
    const thresholdIso = new Date(Date.now() - HUNG_THRESHOLD_MS).toISOString()
    const stale = this.db.getStaleDispatches(thresholdIso, this.state.runId)
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
      this.state.completedTasks.push(result.taskId)
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
    const pendingGates = this.db.listGates({
      status: 'pending',
      coordinatorRunId: this.state.runId
    })
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
    // Why (F2 #13): worktree-backed dispatch is a separate, opt-in path so the
    // legacy bare-terminal flow below stays byte-for-byte unchanged when off.
    // Guard on the runtime capability too: a runtime without createWorktree can
    // never satisfy worktreeBacked, so it safely falls through to legacy.
    if (this.opts.worktreeBacked && this.runtime.createWorktree) {
      await this.dispatchReadyTasksInWorktrees()
      return
    }
    if (
      this.opts.worktreeBacked &&
      !this.runtime.createWorktree &&
      !this.warnedMissingCreateWorktree
    ) {
      // Why (round 2, nit): don't silently downgrade. Surface the fallback once.
      this.warnedMissingCreateWorktree = true
      this.opts.onLog(
        'worktreeBacked requested but this runtime does not implement createWorktree; ' +
          'falling back to legacy bare-terminal dispatch'
      )
    }

    this.state.phase = 'dispatching'
    const readyTasks = this.db.listTasks({ ready: true, coordinatorRunId: this.state.runId })
    if (readyTasks.length === 0) {
      return
    }

    // Why: count currently dispatched tasks to enforce concurrency limit.
    const dispatched = this.db.listTasks({
      status: 'dispatched',
      coordinatorRunId: this.state.runId
    })
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

  // Why (F2 #13, slice 2 / design §3.3, §5): worktree-backed dispatch over the
  // track model. Each ready task maps to a track (spec `track:` hint → default =
  // task id). The FIRST dispatch of a track lazily creates a child worktree whose
  // lineage parent is the director (`opts.worktree`) so selectSpawnedWorktreeIds
  // finds the worker with no Mission Control change; LATER same-track tasks reuse
  // that worktree (review continues implement's branch → one PR). Concurrency is
  // bounded by TWO limits (design §5.2): maxConcurrent AND one-active-dispatch-
  // per-track (two agents in one checkout corrupt it), so effective parallelism =
  // min(maxConcurrent, #distinct ready tracks with no in-flight dispatch).
  private async dispatchReadyTasksInWorktrees(): Promise<void> {
    this.state.phase = 'dispatching'
    const readyTasks = this.db.listTasks({ ready: true, coordinatorRunId: this.state.runId })
    if (readyTasks.length === 0) {
      return
    }

    if (!this.opts.worktree) {
      // Why: lineage needs a parent. Without a director worktree there is no
      // parent edge for Mission Control to key on, so worktree-backed dispatch
      // cannot do its job. Fail loud-but-soft: log and leave tasks ready rather
      // than silently creating orphan (parentless) worktrees.
      this.opts.onLog(
        'worktree-backed dispatch requires a --worktree (director) for lineage; skipping dispatch'
      )
      return
    }

    const dispatched = this.db.listTasks({
      status: 'dispatched',
      coordinatorRunId: this.state.runId
    })
    let slotsAvailable = this.opts.maxConcurrent - dispatched.length
    if (slotsAvailable <= 0) {
      return
    }

    // Why (slice 2, design §3.1 #2 / §5.2): one active dispatch per track. A track
    // is "busy" when any of its tasks is already dispatched; a ready task on a busy
    // track must WAIT (stays ready, retried next tick — the same shape as the
    // legacy "no idle terminal" wait) so two agents never edit one checkout
    // concurrently. Tracks claimed earlier in THIS pass count too, so we also
    // never dispatch two same-track tasks within a single tick.
    const busyTracks = new Set(dispatched.map((t) => this.trackKeyForTask(t)))

    for (const task of readyTasks) {
      if (slotsAvailable <= 0) {
        break
      }

      const trackKey = this.trackKeyForTask(task)
      if (busyTracks.has(trackKey)) {
        // Serialize: a dispatch is already in flight for this track; wait.
        continue
      }

      // Why (round 3): resolve drift on the DIRECTOR BEFORE creating/reusing.
      // A child branches from the director's base, so a stale local base would
      // make every fresh child report behind>threshold and be torn down — an
      // unbounded create→skip→teardown churn loop. Pre-checking skips a stale base
      // WITHOUT creating anything (recoverable, no churn). The resolved drift is
      // threaded into dispatchTask so the worktree is not re-probed. Drift is
      // resolved against the director for both hit and miss (cross-track
      // base-ref-from-predecessor is out of scope — design §10 Q5 / slice note).
      const drift = await this.resolveDispatchDrift(task, this.opts.worktree)
      if (drift.skip) {
        continue
      }

      // Claim the track for this tick BEFORE provisioning so a later same-track
      // ready task in this same pass waits instead of racing into the checkout.
      // (Waiting is always safe; a failed attempt simply retries next tick.)
      busyTracks.add(trackKey)

      const existing = this.trackWorktrees.get(trackKey)
      const dispatchedOk = existing
        ? await this.dispatchIntoExistingTrack(task, trackKey, existing, drift)
        : await this.createTrackWorktreeAndDispatch(task, trackKey, drift)

      if (dispatchedOk) {
        slotsAvailable--
      }
    }
  }

  // Why (slice 2, miss path): first dispatch of a track. Create a child worktree
  // (lineage parent = director), dispatch the preamble into the launched worker
  // agent, and — only on success — cache the worktree so later same-track tasks
  // reuse it. Returns true when the task was dispatched. Mirrors slice-1 failure
  // handling: a created-but-unusable or failed-to-dispatch worktree is torn down
  // and breaker-accounted so repeated failures converge instead of orphaning.
  private async createTrackWorktreeAndDispatch(
    task: TaskRow,
    trackKey: string,
    drift: DispatchDrift
  ): Promise<boolean> {
    let created: { worktreeId: string; branch: string; terminalHandle?: string }
    try {
      created = await this.runtime.createWorktree!({
        parentWorktree: this.opts.worktree!,
        // Why: name the track's branch after its lead (first) task. Reuse within a
        // run is via the in-memory map, so determinism is not required here; the
        // run-namespaced, track-deterministic naming of design §6 is an F3-resume
        // enabler — TODO(F3 #14), out of scope for this slice.
        name: worktreeNameForTask(task),
        orchestrationRunId: this.state.runId,
        taskId: task.id,
        coordinatorHandle: this.opts.coordinatorHandle,
        ...(this.opts.workerAgent ? { startup: { agent: this.opts.workerAgent } } : {})
      })
    } catch (err) {
      // Why (round 2): createManagedWorktree validation (e.g. a disabled/invalid
      // agent) throws BEFORE a worktree is created, so there is nothing to orphan
      // here. Route the failure through the SAME breaker F1 uses so a task that can
      // never be provisioned gives up after N strikes instead of retrying forever.
      this.recordWorktreeProvisionFailure(task, err)
      return false
    }

    // Why (round 2): the adapter returns a handle for the agent it launched, or —
    // when no agent was requested — the plain terminal createManagedWorktree
    // already opened (it does NOT create a second one). A missing handle means the
    // worktree exists but has no usable terminal: tear it down so it does not
    // orphan, and breaker-account so we don't loop recreating it.
    if (!created.terminalHandle) {
      this.opts.onLog(
        `No worker terminal in worktree ${created.worktreeId} for task ${task.id}; removing it`
      )
      await this.teardownWorktree(created.worktreeId)
      this.recordWorktreeProvisionFailure(
        task,
        new Error('created worktree had no usable worker terminal')
      )
      return false
    }

    // Why (round 2): wait for the agent TUI to be ready before sending the
    // preamble only when we actually launched an agent. A plain shell (no
    // workerAgent) accepts input immediately, so gating it on tui-idle would just
    // risk a needless timeout.
    const awaitReady = this.opts.workerAgent !== undefined
    try {
      await this.dispatchTask(
        task,
        created.terminalHandle,
        `id:${created.worktreeId}`,
        awaitReady,
        drift
      )
    } catch (err) {
      // dispatchTask already breaker-accounted the readiness/send failure. Tear
      // down the (not-yet-cached) worktree so retries don't leave an orphan.
      this.opts.onLog(
        `Failed to dispatch task ${task.id} in worktree ${created.worktreeId}: ${err}`
      )
      await this.teardownWorktree(created.worktreeId)
      return false
    }

    // Cache only AFTER a successful first dispatch so a torn-down (failed) worktree
    // is never handed to a same-track successor.
    this.trackWorktrees.set(trackKey, {
      worktreeId: created.worktreeId,
      terminalHandle: created.terminalHandle,
      isAgent: this.opts.workerAgent !== undefined
    })
    this.opts.onLog(`Created worktree ${created.branch} for track ${trackKey} (task ${task.id})`)
    return true
  }

  // Why (slice 2, hit path): a same-track successor (e.g. review after implement).
  // Reuse the track's existing worktree — it already holds the predecessor's
  // commits, which IS the git-artifact handoff (#5). Dispatch into a terminal in
  // that worktree (the cached worker agent if still usable, else a fresh one).
  // Crucially, a dispatch failure here does NOT tear the worktree down: it holds
  // the predecessor's work. dispatchTask still breaker-accounts the strike so a
  // permanently-failing successor converges.
  private async dispatchIntoExistingTrack(
    task: TaskRow,
    trackKey: string,
    track: { worktreeId: string; terminalHandle: string; isAgent: boolean },
    drift: DispatchDrift
  ): Promise<boolean> {
    const target = await this.resolveTrackTerminal(track)
    if (!target) {
      // No usable terminal could be found or opened in the reused worktree. Do
      // NOT tear it down (it holds the predecessor's work). Breaker-account so a
      // permanently-unusable track converges instead of retrying every tick.
      this.recordWorktreeProvisionFailure(
        task,
        new Error(`no usable terminal in reused track worktree ${track.worktreeId}`)
      )
      return false
    }

    try {
      // Why (slice 2 hard constraint): the tui-idle readiness gate applies to a
      // reused agent terminal too — the same race exists. A freshly opened plain
      // terminal accepts input immediately, so it is not gated.
      await this.dispatchTask(task, target.handle, `id:${track.worktreeId}`, target.isAgent, drift)
    } catch (err) {
      this.opts.onLog(
        `Failed to dispatch task ${task.id} into reused track ${trackKey} worktree ${track.worktreeId}: ${err}`
      )
      return false
    }

    // Refresh the cached terminal in case the fallback opened a fresh one.
    this.trackWorktrees.set(trackKey, {
      worktreeId: track.worktreeId,
      terminalHandle: target.handle,
      isAgent: target.isAgent
    })
    this.opts.onLog(`Reused track ${trackKey} worktree ${track.worktreeId} for task ${task.id}`)
    return true
  }

  // Why (slice 2, design §5.3 / Q4; round 3 must-fix #1): pick the terminal for a
  // same-track re-dispatch. Prefer the cached worker-agent terminal when it is
  // still connected/writable — per-track serialization guarantees it is idle now,
  // and reusing it keeps the worker's context for the handoff.
  //
  // If the cached terminal is GONE, we must NOT downgrade an agent run to a bare
  // shell: sending the agent preamble into a plain shell never produces
  // worker_done, so the track stays busy on a dead dispatch (this is the
  // implement→review path — implement's agent exits after its grace window, then
  // review reuses the track). So when this run launches workers as agents, we
  // RELAUNCH the worker agent in the SAME worktree via launchAgentTerminal — the
  // REAL agent spawn (createTerminal's `launchAgent` is only a tag; it spawns a
  // shell). It targets the existing checkout, NOT a new worktree, so the
  // predecessor's commits are preserved. An empty prompt is fine: the agent is
  // spawned here and the dispatch preamble is sent afterwards via sendTerminal
  // (dispatchTask), exactly like slice-1's create→sendTerminal flow. A no-agent
  // run opens a plain shell, the same kind it started with. Any failure (or a
  // runtime without launchAgentTerminal) returns null → the caller breaker-accounts
  // it and leaves the shared worktree intact. Never returns a non-agent terminal
  // for an agent run.
  private async resolveTrackTerminal(track: {
    worktreeId: string
    terminalHandle: string
    isAgent: boolean
  }): Promise<{ handle: string; isAgent: boolean } | null> {
    try {
      const { terminals } = await this.runtime.listTerminals(`id:${track.worktreeId}`)
      const cached = terminals.find(
        (t) => t.handle === track.terminalHandle && t.connected && t.writable
      )
      if (cached) {
        return { handle: track.terminalHandle, isAgent: track.isAgent }
      }
    } catch {
      // Fall through to (re)launching a terminal.
    }
    // Decide agent-vs-shell from the RUN config, not the cached flag, so a prior
    // fallback can never permanently downgrade an agent track to a shell.
    const wantsAgent = this.opts.workerAgent !== undefined
    if (wantsAgent) {
      if (!this.runtime.launchAgentTerminal) {
        // No real agent-spawn capability → refuse to dispatch into a shell.
        this.opts.onLog(
          `Cannot relaunch the worker agent in reused worktree ${track.worktreeId}: runtime lacks launchAgentTerminal`
        )
        return null
      }
      try {
        const created = await this.runtime.launchAgentTerminal(`id:${track.worktreeId}`, {
          agent: this.opts.workerAgent!,
          prompt: '',
          title: `Worker (track reuse)`
        })
        return { handle: created.handle, isAgent: true }
      } catch (err) {
        this.opts.onLog(
          `Failed to relaunch the worker agent in reused worktree ${track.worktreeId}: ${err}`
        )
        return null
      }
    }
    try {
      const created = await this.runtime.createTerminal(`id:${track.worktreeId}`, {
        title: `Worker (track reuse)`
      })
      return { handle: created.handle, isAgent: false }
    } catch (err) {
      this.opts.onLog(`Failed to open a terminal in reused worktree ${track.worktreeId}: ${err}`)
      return null
    }
  }

  // Why (slice 2): a task's track = its `track:` spec hint, or its own id when
  // unset (→ per-task, the collision-free slice-1 default).
  private trackKeyForTask(task: Pick<TaskRow, 'id' | 'spec'>): string {
    return parseTrackFromSpec(task.spec).trackKey ?? task.id
  }

  // Why (round 2): worktree/terminal provisioning fails BEFORE a real dispatch
  // context exists (there is no worker handle yet), so we route the strike
  // through the SAME circuit breaker F1 uses — create a context against a unique
  // per-task sentinel handle, then immediately failDispatch it. failDispatch
  // carries failure_count forward (db.ts createDispatchContext MAX), so these
  // strikes accumulate with real dispatch failures: after 3 the task is marked
  // failed instead of retrying forever; below 3 it returns to 'ready' to retry.
  private recordWorktreeProvisionFailure(task: TaskRow, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    try {
      const sentinelHandle = `orch-provision:${task.id}`
      const ctx = this.db.createDispatchContext(task.id, sentinelHandle)
      const updated = this.db.failDispatch(ctx.id, message)
      if (updated?.status === 'circuit_broken') {
        this.state.failedTasks.push(task.id)
        this.opts.onLog(
          `Task ${task.id} failed: could not provision a worktree after repeated attempts (${message})`
        )
      } else {
        this.opts.onLog(
          `Worktree provisioning for ${task.id} failed (strike ${updated?.failure_count ?? '?'}/3): ${message}`
        )
      }
    } catch (err) {
      this.opts.onLog(`Failed to record provisioning failure for ${task.id}: ${err}`)
    }
  }

  // Why (round 2): best-effort teardown of a just-created child worktree so a
  // failed dispatch does not leak an orphan. force-removes via the runtime; a
  // teardown error is logged, not thrown (cleanup must never mask the original
  // dispatch failure).
  private async teardownWorktree(worktreeId: string): Promise<void> {
    if (!this.runtime.removeWorktree) {
      return
    }
    try {
      await this.runtime.removeWorktree(worktreeId)
    } catch (err) {
      this.opts.onLog(`Failed to remove worktree ${worktreeId}: ${err}`)
    }
  }

  // Returns true when the task was dispatched, false when the drift pre-flight
  // skipped it (task left 'ready'). Throws when the dispatch itself fails (the
  // failure is breaker-accounted before the throw).
  // Why (§3.1): pre-flight drift check BEFORE `createDispatchContext` so a
  // refusal does NOT increment failure_count. createDispatchContext carries
  // `MAX(failure_count)` forward across contexts (db.ts:301-306), so burning
  // the circuit-breaker budget here would convert a recoverable "fetch and
  // retry" into a hard `failed` task within ~6s of polling. A `skip` leaves the
  // task in `ready`; the next `dispatchReadyTasks` tick retries naturally, and
  // once the base has been refreshed dispatch proceeds cleanly.
  private async resolveDispatchDrift(
    task: TaskRow,
    driftSelector: string | undefined
  ): Promise<DispatchDrift> {
    // Why (slice 2): strip BOTH infra hints from the preamble spec — the
    // stale-base flag and the `track:` line — so neither leaks into the worker's
    // `--- TASK ---` block. Shared by both dispatch paths exactly like the
    // stale-base strip already was; a spec carrying neither hint is unchanged
    // (legacy byte-for-byte preserved).
    const { allowStale, strippedSpec: withoutStaleBase } = parseAllowStaleBaseFromSpec(task.spec)
    const strippedSpec = parseTrackFromSpec(withoutStaleBase).strippedSpec

    if (!driftSelector) {
      // Why (§7.4): CoordinatorOptions.worktree is optional. When undefined,
      // probeWorktreeDrift cannot resolve a selector; log once so operators
      // can see the guard did not run for this task and proceed. v2 may
      // always resolve a worktree via the coordinator-terminal handle.
      this.opts.onLog(`stale-base guard inert for ${task.id}: coordinator has no worktree selector`)
      return { skip: false, baseDrift: null, strippedSpec }
    }

    const baseDrift = await this.runtime.probeWorktreeDrift(driftSelector).catch((err) => {
      this.opts.onLog(`probeWorktreeDrift failed for ${driftSelector}: ${err}`)
      return null
    })

    if (baseDrift && baseDrift.behind > DISPATCH_STALE_THRESHOLD && !allowStale) {
      // Why (§3.1): skip, NOT failDispatch (which would burn the circuit-breaker
      // budget). The message lists three remediations so the operator can recover.
      this.opts.onLog(
        `Skipping dispatch of ${task.id}: worktree is ${baseDrift.behind} commits ` +
          `behind ${baseDrift.base}. Pull/rebase the worktree, recreate it with ` +
          `--base-branch ${baseDrift.base}, or include 'allow-stale-base: true' ` +
          `in the task spec to override. Task remains in 'ready'; coordinator ` +
          `will retry on the next tick.`
      )
      return { skip: true, baseDrift, strippedSpec }
    }

    return { skip: false, baseDrift, strippedSpec }
  }

  private async dispatchTask(
    task: TaskRow,
    targetHandle: string,
    // Why (F2 #13): the worktree to drift-probe when this method computes drift
    // itself (the legacy path passes nothing → defaults to the director). The
    // worktree-backed path pre-computes drift before creating the worktree and
    // passes it via `precomputedDrift`, so this selector is unused there.
    driftWorktreeSelector?: string,
    // Why (F2 #13, round 2): wait for the agent TUI to reach tui-idle before
    // sending the preamble. Default false → the legacy path is byte-for-byte
    // unchanged (it dispatches to already-idle terminals, so no wait is needed).
    awaitTerminalReady = false,
    // Why (F2 #13, round 3): the worktree-backed path resolves drift on the
    // director BEFORE createWorktree (so a stale base skips without churning a
    // worktree) and threads the result here so we don't re-probe the fresh child.
    // Omitted on the legacy path → drift is resolved here exactly as before.
    precomputedDrift?: DispatchDrift
  ): Promise<boolean> {
    const drift =
      precomputedDrift ??
      (await this.resolveDispatchDrift(task, driftWorktreeSelector ?? this.opts.worktree))
    if (drift.skip) {
      return false
    }
    const { baseDrift, strippedSpec } = drift

    const dispatch = this.db.createDispatchContext(task.id, targetHandle)

    // Why: agents dispatched by the coordinator must use orca-dev in dev mode
    // so they talk to the dev runtime's socket, not production (Section 6.4).
    // Why (§3.4): `strippedSpec` drops the `allow-stale-base: true` line so
    // the worker's `--- TASK ---` block does not contain the infra flag (which
    // the worker would otherwise read as part of its instructions).
    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId: dispatch.id,
      // Why (§3.4, stale-base PR): use `strippedSpec` not `task.spec` so the
      // `allow-stale-base: true` line isn't rendered into the worker's
      // --- TASK --- block (worker would otherwise treat the infra flag as
      // part of its instructions).
      taskSpec: strippedSpec,
      coordinatorHandle: this.opts.coordinatorHandle,
      devMode: process.env.ORCA_USER_DATA_PATH?.includes('orca-dev'),
      // Why (§3.2): drift section fires only when behind > 0. The preamble
      // builder gates on this itself; passing the object unconditionally lets
      // the coordinator stay dumb about the display rule.
      ...(baseDrift ? { baseDrift } : {})
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
      // Why (round 2, BLOCKER): gate the preamble on agent readiness. createWorktree
      // returns as soon as the startup PTY is spawned, NOT when the agent TUI
      // accepts input — sending immediately drops keystrokes into a booting
      // claude/codex and the worker never sees its task. Reuse the runtime's
      // existing readiness signal (waitForTerminal tui-idle) rather than
      // hand-rolling a poller. A timeout rejects and is breaker-accounted below.
      if (awaitTerminalReady) {
        await this.runtime.waitForTerminal(targetHandle, {
          condition: 'tui-idle',
          timeoutMs: DISPATCH_READINESS_TIMEOUT_MS
        })
      }
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
    return true
  }

  private async getAvailableTerminals(): Promise<string[]> {
    try {
      const result = await this.runtime.listTerminals(this.opts.worktree)
      const dispatched = this.db.listTasks({
        status: 'dispatched',
        coordinatorRunId: this.state.runId
      })
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
    const tasks = this.db.listTasks({ coordinatorRunId: this.state.runId })
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
