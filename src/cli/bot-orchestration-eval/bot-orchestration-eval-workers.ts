// The stand-in's workers: starting one, a report settling it, and its terminal closing on its own
// once the runtime's grace passes, in the runtime's receipt shapes.
import { RuntimeClientError } from '../runtime/connection/types'
import { composeWorktreeId } from '../../shared/worktree/id'
import { EVAL_BOT, type EvalHostState } from '../bot-automation-eval/bot-automation-eval-host'

/** A worker as the stand-in keeps it; list and show answer from it in the runtime's shapes. */
export type StandInWorker = {
  dispatchId: string
  taskId: string
  worktreeId: string
  terminalHandle: string
  agent?: unknown
  spec?: unknown
  /** The runtime's WorkerDispatchState. */
  state: 'ready' | 'succeeded' | 'failed' | 'stopped' | 'stop_unknown'
  /** Its terminal: open, closed on its own after the worker finished, or kept open on request. */
  terminal: 'active' | 'released' | 'retained'
  /** The paired server it runs on; absent on this machine. */
  server?: string
  followUpOf?: string
  lastError?: string
}
/** What the stand-in did with a worker start, recorded with it so grading never re-resolves. */
export type WorkerStartVerdict =
  | { accepted: true; repoId: string | null; worktreeId: string; dispatchId: string }
  /** hostFailed: the host could not start it (a scenario's failure), not a call it refuses. */
  | { accepted: false; error: string; hostFailed?: true }
/** The run every stand-in worker joins; scenarios address woken-turn mail to it. */
export const EVAL_RUN_ID = 'run_eval_1'
const FINISHED = ['succeeded', 'failed'] as const
export const EVAL_RUN = { id: EVAL_RUN_ID, objective: 'Bot hand-offs', created: false }
// The runtime's receipt `next` line.
const AWAIT_WAKE = "Orca wakes you when workers report; end your turn when you're done."

// The runtime's resolveRepoSelector: exact id, path or display name, with an optional prefix.
export function resolveRepo(
  state: EvalHostState,
  selector: unknown
): EvalHostState['repos'][number] {
  const text = String(selector ?? '')
  const prefix = /^(id|path|name):/.exec(text)?.[1]
  const value = prefix ? text.slice(prefix.length + 1) : text
  const matches = state.repos.filter(
    (repo) =>
      ((!prefix || prefix === 'id') && repo.id === value) ||
      ((!prefix || prefix === 'path') && repo.path === value) ||
      ((!prefix || prefix === 'name') && repo.displayName === value)
  )
  if (matches.length > 1) {
    throw new RuntimeClientError('selector_ambiguous', 'selector_ambiguous')
  }
  if (!matches[0]) {
    throw new RuntimeClientError('repo_not_found', 'repo_not_found')
  }
  return matches[0]
}

// With no --name, the runtime picks an unused sea-creature name and the receipt names the workspace.
const GENERATED_NAMES = ['otter', 'narwhal', 'manatee', 'octopus', 'seahorse', 'walrus', 'orca']

function generatedName(state: EvalHostState): string {
  const used = new Set((state.worktrees ?? []).map((row) => row.displayName))
  return (
    GENERATED_NAMES.find((name) => !used.has(name)) ??
    `sea-creature-${(state.worktrees ?? []).length}`
  )
}

export function addWorker(
  state: EvalHostState,
  worker: Omit<StandInWorker, 'dispatchId' | 'taskId' | 'terminalHandle'>
): StandInWorker {
  const workers = (state.workers ??= [])
  const n = workers.length + 1
  const added = {
    dispatchId: `ctx_w${n}`,
    taskId: `task_${n}`,
    terminalHandle: `term_w${n}`,
    ...worker
  }
  workers.push(added)
  return added
}

export function readyReceipt(worker: StandInWorker, effects: Record<string, unknown>[]) {
  return {
    state: 'ready',
    runId: EVAL_RUN_ID,
    taskId: worker.taskId,
    dispatchId: worker.dispatchId,
    stage: 'input_accepted',
    effects,
    residualResources: [],
    next: AWAIT_WAKE,
    run: EVAL_RUN
  }
}

export function workerStart(
  state: EvalHostState,
  params: Record<string, unknown>
): { receipt: Record<string, unknown>; verdict: WorkerStartVerdict } {
  const placement = String(params.worktree ?? 'current')
  const creates = placement === 'new-child' || placement === 'new-top-level'
  // The runtime's checks, in its order and words, for a caller whose workspace is a bot's home folder.
  if (placement === 'new-child' && !params.repo) {
    throw new RuntimeClientError(
      'invalid_argument',
      'A worker started from a folder workspace needs --repo to create a worktree.'
    )
  }
  if (!params.terminal && !params.agent) {
    throw new RuntimeClientError(
      'agent_unconfigured',
      'A configured --agent is required when worker-start creates a terminal. Pass --agent with one of: claude, codex, grok, opencode, omp.'
    )
  }
  const repo = creates ? resolveRepo(state, params.repo) : null
  const server = typeof params.on === 'string' ? params.on : undefined
  // A scenario's host that cannot start workers: the start fails after its Task exists.
  if (state.startFailure) {
    const failed = addWorker(state, {
      worktreeId: '',
      agent: params.agent,
      spec: params.spec,
      state: 'failed',
      terminal: 'released',
      server,
      lastError: state.startFailure.error
    })
    return {
      receipt: {
        runId: EVAL_RUN_ID,
        taskId: failed.taskId,
        dispatchId: failed.dispatchId,
        state: 'failed',
        stage: state.startFailure.stage,
        failedStage: state.startFailure.stage,
        lastError: state.startFailure.error,
        residualResources: [],
        run: EVAL_RUN
      },
      verdict: { accepted: false, error: state.startFailure.error, hostFailed: true }
    }
  }
  const effects: Record<string, unknown>[] = []
  let worktreeId = 'folder:bot-home'
  let repoId = repo?.id ?? null
  // An existing workspace by id, as a hand-off names it.
  const existing = creates ? undefined : existingWorktree(state, placement)
  if (existing) {
    worktreeId = String(existing.worktreeId)
    repoId = String(existing.repoId)
  }
  if (repo) {
    const name = params.name ? String(params.name) : generatedName(state)
    const path = `${repo.path}-workspaces/${name}`
    worktreeId = composeWorktreeId(repo.id, path)
    effects.push({
      kind: 'worktree',
      action: placement === 'new-child' ? 'created_child' : 'created_top_level',
      id: worktreeId,
      name
    })
    ;(state.worktrees ??= []).push({
      workspaceKind: 'git',
      worktreeId,
      repoId: repo.id,
      repo: repo.displayName,
      hostId: server ?? 'local',
      path,
      branch: `refs/heads/${name}`,
      displayName: name,
      parentWorktreeId: 'folder:bot-home',
      bot: state.bots.find((bot) => bot.id === EVAL_BOT.id)?.name ?? EVAL_BOT.name,
      lastActivityAt: Date.now(),
      isArchived: false,
      liveTerminalCount: 1,
      hasAttachedPty: true,
      unverifiableTerminalCount: 0,
      status: 'active',
      agents: [{ state: 'working', agentType: params.agent ?? 'claude', prompt: params.spec }]
    })
  }
  const worker = addWorker(state, {
    worktreeId,
    agent: params.agent,
    spec: params.spec,
    state: 'ready',
    terminal: 'active',
    server
  })
  effects.push({ kind: 'terminal', role: 'agent', action: 'created', id: worker.terminalHandle })
  return {
    receipt: readyReceipt(worker, effects),
    verdict: { accepted: true, repoId, worktreeId, dispatchId: worker.dispatchId }
  }
}
function existingWorktree(state: EvalHostState, placement: string) {
  const id = placement.startsWith('id:') ? placement.slice(3) : placement
  return (state.worktrees ?? []).find((row) => row.worktreeId === id)
}

export function findWorker(state: EvalHostState, dispatchId: unknown): StandInWorker | undefined {
  return (state.workers ?? []).find((worker) => worker.dispatchId === dispatchId)
}

export function workerOrThrow(
  state: EvalHostState,
  dispatchId: unknown,
  prefix = ''
): StandInWorker {
  const worker = findWorker(state, dispatchId)
  if (!worker) {
    throw new RuntimeClientError(
      'dispatch_not_found',
      `${prefix}Dispatch ${String(dispatchId)} was not found.`
    )
  }
  return worker
}

/** A worker reports: its Dispatch settles, as worker_done settles it on a real host. */
export function settleWorker(
  state: EvalHostState,
  dispatchId: string,
  outcome: 'succeeded' | 'failed'
): void {
  const worker = findWorker(state, dispatchId)
  if (worker?.state === 'ready') {
    worker.state = outcome
  }
}
/** The grace passes: every finished worker's terminal closes on its own. */
export function closeFinishedWorkers(state: EvalHostState): void {
  for (const worker of state.workers ?? []) {
    if (FINISHED.some((done) => done === worker.state) && worker.terminal === 'active') {
      worker.terminal = 'released'
    }
  }
}
