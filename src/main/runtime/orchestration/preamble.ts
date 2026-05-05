export type PreambleParams = {
  taskId: string
  // Why: the heartbeat payload attributes liveness to a specific dispatch
  // context (not just a task). A retried task has multiple dispatch_contexts
  // rows; keying heartbeats on dispatchId prevents a straggler heartbeat from
  // a previously-failed dispatch from masking a hung retry. Both call sites
  // already have this value in scope (coordinator.ts dispatch.id, rpc
  // orchestration.ts ctx.id).
  dispatchId: string
  taskSpec: string
  coordinatorHandle: string
  devMode?: boolean
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
  // Why: in dev mode, agents must use orca-dev to connect to the dev runtime's
  // socket. Without this, agents inside the dev Electron app would call the
  // production CLI and talk to the wrong Orca instance (Section 6.4).
  const cli = params.devMode ? 'orca-dev' : 'orca'

  const header = `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your coordinator's terminal handle is: ${params.coordinatorHandle}
Your task ID is: ${params.taskId}

You talk to the coordinator only through the CLI commands below. Do not use
Slack, GitHub comments, or any other channel to reach a human during the run.

=== CLI COMMANDS ===

  # Report task completion (REQUIRED when done — even on failure).
  #
  # RULE: --body must be a 3-sentence executive summary (what you did,
  # what you found, what's left). Never send an empty body; the coordinator
  # reads the body first and only opens artifacts if it needs more detail.
  # If you produced a long-form artifact, include its path as
  # payload.reportPath so the coordinator can find it without a file search.
  #
  # RULE: send worker_done exactly once. Failure is still a worker_done
  # with subject like "Failed: <reason>" — never silently exit.
  ${cli} orchestration send --to ${params.coordinatorHandle} \\
    --type worker_done --subject "<short status>" \\
    --body "<3-sentence summary: what you did, what you found, what's left>" \\
    --payload '{"taskId":"${params.taskId}","filesModified":["path/a","path/b"],"reportPath":"<optional: path to the full artifact>"}'

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
  ${cli} orchestration send --to ${params.coordinatorHandle} \\
    --type heartbeat --subject "alive" \\
    --payload '{"taskId":"${params.taskId}","dispatchId":"${params.dispatchId}","phase":"<short: investigating|implementing|reviewing|waiting>"}'

  # Ask the coordinator a question and block until it answers.
  #
  # BEHAVIOR RULE #1 (MUST NOT VIOLATE):
  # NEVER use AskUserQuestion; use \`${cli} orchestration ask\` or send
  # --type decision_gate. AskUserQuestion opens a local TUI prompt that the
  # coordinator cannot see and cannot answer — your session will hang forever
  # waiting on a human. Every interactive question goes through \`ask\` below.
  #
  # The \`ask\` verb is a thin wrapper: it sends a decision_gate message and
  # blocks on \`check --wait\` until the coordinator replies, then prints the
  # reply body. Use it anywhere you would otherwise have reached for
  # AskUserQuestion.
  ${cli} orchestration ask --to ${params.coordinatorHandle} \\
    --question "<your question>" \\
    --options "<optional,comma,separated>" \\
    --timeout-ms 600000

  # Escalate a blocker or failure (pre-completion, when you need the
  # coordinator to do something before you can continue):
  ${cli} orchestration send --to ${params.coordinatorHandle} \\
    --type escalation --subject "Blocked: <reason>" \\
    --body "<details>" \\
    --payload '{"taskId":"${params.taskId}"}'

  # Check for messages from the coordinator:
  ${cli} orchestration check

=== AFTER YOU SEND worker_done ===

Keep the shell session open for a grace period (10 minutes) in case the
coordinator sends a follow-up or re-dispatches you. Poll with
\`${cli} orchestration check\` every 2 minutes during that window. If no
follow-up arrives, you may exit after the grace period — the coordinator
will not expect further output from you.

If the coordinator re-dispatches you (you will receive a fresh preamble +
TASK block), reset your polling and start the new task. Do not respond
to the previous task's follow-ups after a re-dispatch.`

  // Why: the drift section fires only when the coordinator allowed dispatch
  // against a stale worktree (via `allow-stale-base: true` in the task spec,
  // see §3.4) OR when behind>0 but under the refusal threshold. Either way
  // it is defense-in-depth: the worker sees the drift from line 1 instead
  // of discovering it via stale line numbers in artifacts later.
  const drift =
    params.baseDrift && params.baseDrift.behind > 0 ? buildDriftSection(params.baseDrift) : ''

  return `${header}${drift}

=== TASK ===
${params.taskSpec}`
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
