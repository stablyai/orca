import type { OrchestrationCliCommand } from './cli-command'
import {
  buildWorkerProtocolContext,
  renderWorkerBootstrap,
  renderRetainedDispatchDelta
} from './control-plane/worker-protocol-context'

export type PreambleParams = {
  taskId: string
  // Why: completion and heartbeat payloads attribute activity to a specific
  // dispatch context (not just a task). A retried task has multiple
  // dispatch_contexts rows; keying worker_done/heartbeat on dispatchId
  // prevents stale messages from a previously-failed dispatch from completing
  // or refreshing the retry.
  dispatchId: string
  dispatchCapability?: string
  taskSpec: string
  coordinatorHandle: string
  workerHandle: string
  // Why: bound in the runtime-generated context so a worker never has to infer
  // which Run or business outcome its Dispatch belongs to (§B5).
  runId?: string
  outcomeId?: string
  devMode?: boolean
  // Why: packaged WSL panes install the scoped launcher as `orca-ide`;
  // other execution hosts keep their existing bare `orca` bridge.
  cliCommand?: OrchestrationCliCommand
  // Why: populated by the coordinator's dispatch pre-flight (§3.1) only
  // when the target worktree is behind its tracking remote. When absent
  // or when `behind === 0`, the preamble emits no drift section. Callers
  // must NOT pre-populate this with empty data; the drift section is a
  // loud-but-rare signal tied to the `allow-stale-base: true` override
  // path, and polluting it for fresh worktrees would train workers to
  // ignore it.
  baseDrift?: {
    base: string
    behind: number
    recentSubjects: string[]
  }
  // Why: prompt-returning agents should idle after worker_done, while bare
  // shells have no agent prompt for Orca to reuse.
  workerKind?: 'prompt-returning-agent' | 'bare-shell'
  // Why gated: advertising a verb the depth cap will reject just burns a turn.
  canDispatchSubWorkers?: boolean
}

// Why: the dispatch preamble teaches agents about Orca's CLI commands for
// structured communication. Behavioral rules (body summary, no-AskUserQuestion)
// live as inline comments above the relevant CLI example, not as a separate
// prose block — LLM readers anchor on examples and skim trailing prose, so
// rules must land at the point of use.
//
// Liveness is deliberately absent: the runtime owns it from process/session
// state, so there is no model-generated heartbeat cadence to teach (§B4).
export function buildDispatchPreamble(params: PreambleParams): string {
  // Why: in dev mode, agents must use orca-dev to connect to the dev runtime's
  // socket. Without this, agents inside the dev Electron app would call the
  // production CLI and talk to the wrong Orca instance (Section 6.4).
  const cli = params.devMode ? 'orca-dev' : (params.cliCommand ?? 'orca')
  const context = buildWorkerProtocolContext({
    identity: {
      taskId: params.taskId,
      dispatchId: params.dispatchId,
      runId: params.runId ?? null,
      outcomeId: params.outcomeId ?? null,
      coordinatorHandle: params.coordinatorHandle,
      workerHandle: params.workerHandle,
      dispatchCapability: params.dispatchCapability
    },
    cli
  })
  const postDoneInstructions = buildPostWorkerDoneInstructions({
    cli,
    workerKind: params.workerKind ?? 'prompt-returning-agent'
  })
  const header = `${renderWorkerBootstrap(context)}\n\n${postDoneInstructions}`

  // Why: the drift section fires only when the coordinator allowed dispatch
  // against a stale worktree (via `allow-stale-base: true` in the task spec,
  // see §3.4) OR when behind>0 but under the refusal threshold. Either way
  // it is defense-in-depth: the worker sees the drift from line 1 instead
  // of discovering it via stale line numbers in artifacts later.
  const drift =
    params.baseDrift && params.baseDrift.behind > 0 ? buildDriftSection(params.baseDrift) : ''

  const subDispatch = params.canDispatchSubWorkers ? buildSubDispatchSection(cli) : ''

  return `${header}${drift}${subDispatch}

=== TASK ===
${params.taskSpec}`
}

/** Re-engagement input for a worker whose session Orca retained. It carries the
 *  dispatch delta and the task only — the worker already has the protocol, so
 *  resending the full manual just buries the new task (§B5). */
export function buildRetainedDispatchDelta(
  params: PreambleParams & { previousTaskId: string; previousDispatchId: string }
): string {
  const context = buildWorkerProtocolContext({
    identity: {
      taskId: params.taskId,
      dispatchId: params.dispatchId,
      runId: params.runId ?? null,
      outcomeId: params.outcomeId ?? null,
      coordinatorHandle: params.coordinatorHandle,
      workerHandle: params.workerHandle,
      dispatchCapability: params.dispatchCapability
    },
    cli: params.devMode ? 'orca-dev' : (params.cliCommand ?? 'orca')
  })
  const delta = renderRetainedDispatchDelta({
    context,
    previous: { taskId: params.previousTaskId, dispatchId: params.previousDispatchId }
  })
  const drift =
    params.baseDrift && params.baseDrift.behind > 0 ? buildDriftSection(params.baseDrift) : ''
  return `${delta}${drift}

=== TASK ===
${params.taskSpec}`
}

function buildPostWorkerDoneInstructions({
  cli,
  workerKind
}: {
  cli: string
  workerKind: NonNullable<PreambleParams['workerKind']>
}): string {
  // Why: re-dispatch reaches idle agents as terminal input; inbox polling
  // after completion cannot receive that new TASK block and looks hung.
  if (workerKind === 'bare-shell') {
    return `=== AFTER YOU REPORT ===

Reporting ends your turn for this task. Your dispatched work is complete:
stop and take no further actions — do NOT start new or unrelated work,
do NOT run a sleep/poll loop, and do NOT keep calling
\`${cli} orchestration check\`. The coordinator has already recorded your
completion and expects no further output.

Exit the shell after completion. Bare-shell workers have no idle agent
prompt for Orca to reuse; if the coordinator has more for you it will
dispatch or prompt another worker with a fresh TASK block.`
  }

  return `=== AFTER YOU REPORT ===

Reporting ends your turn for this task. Your dispatched work is complete:
stop, return to an idle prompt, and take no further actions — do NOT start
new or unrelated work, do NOT run a sleep/poll loop, and do NOT keep calling
\`${cli} orchestration check\`. The coordinator has already recorded your
completion and expects no further output.

A direct instruction from the user takes precedence over this idle rule.
Treat it as new user-owned work: follow it without coordinator approval or a
fresh Dispatch, and do not send lifecycle messages using the settled task or
Dispatch IDs. Never refuse a direct user request because you were a worker.

Do not exit the shell. Your terminal stays available, and if the
coordinator has more for you it will re-engage this terminal with a fresh
dispatch delta + TASK block, which arrives as new input. Treat that as
supervised work under the new Dispatch; ignore stale follow-ups from the
settled task.`
}

// Why the whole section is omitted rather than softened when nesting is off: a
// worker told it "usually cannot" delegate still tries, then reports the refusal
// as a blocker.
function buildSubDispatchSection(cli: string): string {
  return `

=== SUB-DISPATCH ===
You may dispatch sub-workers for this task. Bind your own Run first, then create
and start each one:

  ${cli} orchestration run-create --objective "<what the sub-workers are for>" --json
  ${cli} orchestration task-create --spec "<sub-task>" --json
  ${cli} orchestration worker-start --task <task_id> --worktree current --agent <agent> --json

You own those sub-workers: wait for their completion, and do not report your own
until they have settled. Nesting is capped, so a sub-worker of yours may not be
able to dispatch further.
---`
}

function buildDriftSection(drift: NonNullable<PreambleParams['baseDrift']>): string {
  const subjects = drift.recentSubjects.map((s) => `  - ${s}`).join('\n')
  return `

--- BASE DRIFT ---
Your worktree HEAD is ${drift.behind} commits behind ${drift.base}. The 5 most recent
subjects on ${drift.base} NOT in your worktree:
${subjects}

If any look relevant to your task, either pull them in (\`git pull --rebase
${drift.base}\` or equivalent) or escalate to the coordinator before starting.
---`
}
