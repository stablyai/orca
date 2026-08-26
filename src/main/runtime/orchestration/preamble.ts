import type { OrchestrationCliCommand } from './cli-command'

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
  devMode?: boolean
  // Why: when the target runtime resolved a worker CLI, that execution-host
  // choice is authoritative over the caller-side dev fallback.
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
  // Why: the coordinator may inject task-required protocol actions (extra
  // reports, custom steps) that must complete before worker_done. Inserted
  // verbatim (trimmed) as its own block inside CLI COMMANDS ahead of the
  // worker_done report so agents read the full protocol in execution order.
  preCompletionProtocol?: string
}

// Why: 5 minutes is frequent enough that the coordinator's stale-heartbeat
// check (threshold 10 min) catches a hung worker within one tick, and
// infrequent enough to avoid inbox spam on long tasks. One constant so
// cadence tuning is a single-line change (Q1 in DESIGN_DOC_PREAMBLE_FIX.md).
const HEARTBEAT_INTERVAL_MIN = 5

// Why: the dispatch preamble teaches agents about Orca's CLI commands for
// structured communication. Behavioral rules (body summary, heartbeat cadence,
// no-AskUserQuestion) live as inline comments above the relevant CLI example,
// not as a separate prose block — LLM readers anchor on examples and skim
// trailing prose, so rules must land at the point of use.
export function buildDispatchPreamble(params: PreambleParams): string {
  // Why: target-aware runtime selection wins; devMode is only a fallback for
  // previews/callers that have no concrete worker terminal to resolve.
  const cli = params.cliCommand ?? (params.devMode ? 'orca-dev' : 'orca')
  const postDoneInstructions = buildPostWorkerDoneInstructions({
    cli,
    workerKind: params.workerKind ?? 'prompt-returning-agent'
  })
  const capabilityFlag = params.dispatchCapability
    ? ` --dispatch-capability ${params.dispatchCapability}`
    : ''
  const preCompletionBlock = params.preCompletionProtocol?.trim()
    ? `\n${params.preCompletionProtocol.trim()}\n`
    : ''

  const header = `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your coordinator's terminal handle is: ${params.coordinatorHandle}
Your task ID is: ${params.taskId}

You talk to the coordinator only through the CLI commands below. Do not use
Slack, GitHub comments, or any other channel to reach a human during the run.

=== CLI COMMANDS ===
${preCompletionBlock}
  # Report the terminal task outcome (REQUIRED exactly once).
  #
  # RULE: --body must be a 3-sentence executive summary (what you did,
  # what you found, what's left). Never send an empty body; the coordinator
  # reads the body first and only opens artifacts if it needs more detail.
  # If you produced a long-form artifact, include its path as
  # payload.reportPath so the coordinator can find it without a file search.
  #
  # RULE: send worker_done exactly once. Use --outcome succeeded when the
  # requested work is done, or replace it with --outcome failed when it is not.
  # Never encode failure only in prose and never silently exit.
  # Include BOTH taskId and dispatchId in the payload so a late completion
  # from a failed retry cannot complete the current dispatch.
  #
  # RULE: worker_done is the FINAL Dispatch-scoped protocol action. Complete
  # every other task-required protocol action (ask, escalation, heartbeat)
  # before sending it; once worker_done is accepted, later Dispatch-scoped
  # actions may be rejected.
  ${cli} orchestration send --from ${params.workerHandle}${capabilityFlag} \\
    --type worker_done --subject "<short status>" \\
    --body "<3-sentence summary: what you did, what you found, what's left>" \\
    --task-id ${params.taskId} --dispatch-id ${params.dispatchId} --outcome succeeded \\
    --files-modified "path/a,path/b" \\
    --report-path "<optional: path to the full artifact>"

  # BEHAVIOR RULE: send a heartbeat every ${HEARTBEAT_INTERVAL_MIN} minutes
  # while actively working on the task. The coordinator uses this to
  # distinguish "still thinking" from "hung / crashed." Skip heartbeats only
  # while blocked inside \`check --wait\` or \`ask\` — those calls are
  # themselves liveness signals.
  #
  # Include BOTH taskId and dispatchId in the payload: the coordinator
  # attributes the heartbeat to the specific dispatch context, not just
  # the task, so a straggler heartbeat from a previously-failed dispatch
  # cannot mask a hung retry.
  ${cli} orchestration send --from ${params.workerHandle}${capabilityFlag} \\
    --type heartbeat --subject "alive" \\
    --task-id ${params.taskId} --dispatch-id ${params.dispatchId} \\
    --phase "<short: investigating|implementing|reviewing|waiting>"

  # Ask the coordinator a question and block until it answers.
  #
  # BEHAVIOR RULE #1 (MUST NOT VIOLATE):
  # NEVER use AskUserQuestion; use \`${cli} orchestration ask\`.
  # AskUserQuestion opens a local TUI prompt that the
  # coordinator cannot see and cannot answer — your session will hang forever
  # waiting on a human. Every interactive question goes through \`ask\` below.
  #
  # The \`ask\` verb durably records a question in this Dispatch's Run and
  # blocks until the coordinator replies, then prints the reply body. If the
  # call times out or disconnects, resume with the returned message ID instead
  # of creating a duplicate question.
  ${cli} orchestration ask --from ${params.workerHandle}${capabilityFlag} \\
    --question "<your question>" \\
    --options "<optional,comma,separated>" \\
    --timeout-ms 600000

  # Escalate a blocker or failure (pre-completion, when you need the
  # coordinator to do something before you can continue):
  ${cli} orchestration send --from ${params.workerHandle}${capabilityFlag} \\
    --type escalation --subject "Blocked: <reason>" \\
    --body "<details>" \\
    --task-id ${params.taskId} --dispatch-id ${params.dispatchId}

  # Check for messages from the coordinator:
  ${cli} orchestration check --terminal ${params.workerHandle}

${postDoneInstructions}`

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
    return `=== AFTER YOU SEND worker_done ===

worker_done ends your turn for this task. Your dispatched work is complete:
stop and take no further actions — do NOT start new or unrelated work,
do NOT run a sleep/poll loop, and do NOT keep calling
\`${cli} orchestration check\`. The coordinator has already recorded your
completion and expects no further output.

Exit the shell after completion. Bare-shell workers have no idle agent
prompt for Orca to reuse; if the coordinator has more for you it will
dispatch or prompt another worker with a fresh TASK block.`
  }

  return `=== AFTER YOU SEND worker_done ===

worker_done ends your turn for this task. Your dispatched work is complete:
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
preamble + TASK block, which arrives as new input. Treat that as supervised
work under the new Dispatch; ignore stale follow-ups from the settled task.`
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

You own those sub-workers: wait for their worker_done, and do not report your own
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
