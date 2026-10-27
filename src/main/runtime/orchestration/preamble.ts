import type { OrchestrationCliCommand } from './cli-command'
import type { RuntimeAgentPromptWriteOptions } from '../runtime-terminal-contracts'
import { ORCA_DISPATCH_PROMPT_LEAD_LINE } from '../../../shared/orca-dispatch-status-prompt'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/orca-session-address-prefix'

export type PreambleParams = {
  taskId: string
  // Dispatch ids fence heartbeat/completion authority across retries of one Task.
  dispatchId: string
  taskSpec: string
  /** A terminal handle, or a session's `orca_session_id:<id>`; each is labelled by its kind. */
  coordinatorHandle: string
  workerHandle: string
  devMode?: boolean
  // Packaged WSL uses orca-ide; other hosts retain their existing launcher.
  cliCommand?: OrchestrationCliCommand
  // Supply actual preflight drift only; spurious warnings train workers to ignore stale-base evidence.
  baseDrift?: {
    base: string
    behind: number
    recentSubjects: string[]
  }
  // Prompt-returning agents should idle after completion; bare shells have no reusable agent prompt.
  workerKind?: 'prompt-returning-agent' | 'bare-shell'
  // Do not advertise delegation when depth enforcement will reject it.
  canDispatchSubWorkers?: boolean
  // Federated workers have no local Dispatch row to parent helpers.
  subWorkersInOwnRun?: boolean
  // Null when the user turned heartbeats off: the worker is never told to send them.
  heartbeatIntervalMinutes: number | null
}

/** A session address names a chat worker; any other handle is a terminal. */
function isSessionHandle(handle: string): boolean {
  return handle.startsWith(ORCA_SESSION_ADDRESS_PREFIX)
}

/** Terminal agents keep their handle's wording; only a session is named by its Orca session ID. */
function dispatchIdentityLines(params: PreambleParams): string {
  return [
    isSessionHandle(params.coordinatorHandle)
      ? `Your coordinator's Orca session ID is: ${params.coordinatorHandle}`
      : `Your coordinator's terminal handle is: ${params.coordinatorHandle}`,
    `Your task ID is: ${params.taskId}`,
    ...(isSessionHandle(params.workerHandle)
      ? [`Your Orca session ID is: ${params.workerHandle}`]
      : [])
  ].join('\n')
}

// Place behavior rules beside CLI examples, where agent readers use them.
export function buildDispatchPreamble(params: PreambleParams): string {
  // Dev agents must reach the dev socket through orca-dev.
  const cli = params.devMode ? 'orca-dev' : (params.cliCommand ?? 'orca')
  const chat = isSessionHandle(params.workerHandle)
  const surface = chat ? 'chat' : 'terminal'
  const postDoneInstructions = buildPostWorkerDoneInstructions({
    cli,
    workerKind: params.workerKind ?? 'prompt-returning-agent',
    chat
  })

  const heartbeat =
    params.heartbeatIntervalMinutes === null
      ? ''
      : `  # Send a heartbeat every ${params.heartbeatIntervalMinutes} minutes
  # while actively working on the task. The coordinator uses this to
  # distinguish "still thinking" from "hung / crashed." Skip heartbeats only
  # while blocked inside \`check --wait\` or \`ask\` — those calls are
  # themselves liveness signals.
  #
  # Include BOTH taskId and dispatchId in the payload: the coordinator
  # attributes the heartbeat to the specific dispatch context, not just
  # the task, so a straggler heartbeat from a previously-failed dispatch
  # cannot mask a hung retry.
  ${cli} orchestration send --from ${params.workerHandle} --type heartbeat --subject "alive" --task-id ${params.taskId} --dispatch-id ${params.dispatchId} --phase "<short: investigating|implementing|reviewing|waiting>"

`

  // Use one-line recipes across POSIX/PowerShell/cmd; fence comments and use plain reasons to avoid misleading Chat rendering (STA-8200).
  const header = `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
${dispatchIdentityLines(params)}

The coordinator cannot see this ${surface}, so reach it with the \`${cli} orchestration\`
commands below; a question or result left only in this ${surface} never gets to it.
Don't post to Slack, GitHub, or other channels during the run; report through these commands.

=== CLI COMMANDS ===

\`\`\`sh
  # Report the task outcome (required, exactly once).
  #
  # --body must be a 3-sentence executive summary (what you did,
  # what you found, what's left). Never send an empty body; the coordinator
  # reads the body first and only opens artifacts if it needs more detail.
  # Append --files-modified only when files changed, and append --report-path
  # only when you produced a durable report. Always pass real values; do not
  # send the example placeholders literally.
  #
  # Send worker_done exactly once. Use --outcome succeeded when the
  # requested work is done, or replace it with --outcome failed when it is not.
  # Never encode failure only in prose and never silently exit.
  # Include BOTH taskId and dispatchId in the payload so a late completion
  # from a failed retry cannot complete the current dispatch.
  ${cli} orchestration send --from ${params.workerHandle} --type worker_done --subject "<short status>" --body "<3-sentence summary: what you did, what you found, what's left>" --task-id ${params.taskId} --dispatch-id ${params.dispatchId} --outcome succeeded

${heartbeat}  # Ask the coordinator a question and block until it answers.
  #
  # Use this instead of AskUserQuestion: that opens a local prompt the
  # coordinator cannot see or answer, so the task would stall until someone
  # happened to look at this ${surface}. Send every question through \`ask\`.
  #
  # The \`ask\` verb durably records a question in this Dispatch's Run and
  # blocks until the coordinator replies, then prints the reply body. If the
  # call times out or disconnects, resume with the returned message ID instead
  # of creating a duplicate question.
  ${cli} orchestration ask --from ${params.workerHandle} --question "<your question>" --options "<optional,comma,separated>" --timeout-ms 600000

  # Escalate a blocker or failure (pre-completion, when you need the
  # coordinator to do something before you can continue):
  ${cli} orchestration send --from ${params.workerHandle} --type escalation --subject "Blocked: <reason>" --body "<details>" --task-id ${params.taskId} --dispatch-id ${params.dispatchId}

  # Read coordinator follow-ups. Nothing interrupts you: a durable message only
  # arrives when you look, so run this at each natural checkpoint — before you
  # start a new file and after a test run — and once more immediately before
  # you send worker_done, so a redirect lands before the task settles.
  ${cli} orchestration check --terminal ${params.workerHandle} --json

  # After processing every message, ack the returned deliveryId; this also reads
  # the next batch. Repeat until count is 0, then resume. Unacked batches replay
  # and hide newer mail.
  ${cli} orchestration check --terminal ${params.workerHandle} --ack <delivery_id> --json
\`\`\`

${postDoneInstructions}`

  // Show real drift even below refusal threshold so workers notice stale artifacts early.
  const drift =
    params.baseDrift && params.baseDrift.behind > 0 ? buildDriftSection(params.baseDrift) : ''

  const subDispatch = params.canDispatchSubWorkers
    ? params.subWorkersInOwnRun
      ? buildOwnRunSubDispatchSection(cli)
      : buildSubDispatchSection(cli, params.workerHandle)
    : ''

  return `${header}${drift}${subDispatch}

=== TASK ===
${params.taskSpec}`
}

export type DispatchPreambleSendOptions = Pick<
  RuntimeAgentPromptWriteOptions,
  'leadLine' | 'acceptQueued' | 'observationTimeoutMs' | 'requestId' | 'inputKind' | 'beforeWrite'
>

export function dispatchPreambleSendOptions(requestId: string): DispatchPreambleSendOptions {
  // Why: a delayed provider hook must not revoke an accepted Dispatch.
  return {
    inputKind: 'orchestration',
    leadLine: ORCA_DISPATCH_PROMPT_LEAD_LINE,
    acceptQueued: true,
    observationTimeoutMs: 0,
    requestId
  }
}

export const TERMINAL_REDISPATCH_PARAGRAPH = `Do not exit the shell. Your terminal stays available, and if the
coordinator has more for you it will re-engage this terminal with a fresh
preamble + TASK block, which arrives as new input. Treat that as supervised
work under the new Dispatch; ignore stale follow-ups from the settled task.`

export const CHAT_REDISPATCH_PARAGRAPH = `If the coordinator has more for you, it will send this chat a fresh
preamble + TASK block, which arrives as a new message. Treat that as supervised
work under the new Dispatch; ignore stale follow-ups from the settled task.`

function buildPostWorkerDoneInstructions({
  cli,
  workerKind,
  chat
}: {
  cli: string
  workerKind: NonNullable<PreambleParams['workerKind']>
  chat: boolean
}): string {
  // Redispatch arrives as new input; post-completion inbox polling looks hung. Chats have no shell to exit.
  if (workerKind === 'bare-shell' && !chat) {
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

${chat ? CHAT_REDISPATCH_PARAGRAPH : TERMINAL_REDISPATCH_PARAGRAPH}`
}

// Omit disabled delegation entirely; fence placeholders and separate closing rules so Chat rendering preserves the instructions.
function buildSubDispatchSection(cli: string, workerHandle: string): string {
  return `

=== SUB-DISPATCH ===
You may start helper workers for this task. They work in this Dispatch's Run and
report to you: their questions, escalations, and worker_done arrive in your own
\`check\`, and your coordinator's mail keeps arriving there too.

\`\`\`sh
  ${cli} orchestration worker-start --from ${workerHandle} --spec "<sub-task>" --worktree current --agent <agent> --json
  # Answer a helper's question by its message ID:
  ${cli} orchestration reply --from ${workerHandle} --id <message_id> --body "<answer>"
\`\`\`

Wait for every helper's worker_done before reporting your own. Nesting is
capped; your helpers may not be able to start helpers of their own.

---`
}

function buildOwnRunSubDispatchSection(cli: string): string {
  return `

=== SUB-DISPATCH ===
You may dispatch sub-workers for this task. Create your own Run first, then:

\`\`\`sh
  ${cli} orchestration run-create --objective "<what the sub-workers are for>" --json
  ${cli} orchestration task-create --spec "<sub-task>" --json
  ${cli} orchestration worker-start --task <task_id> --worktree current --agent <agent> --json
\`\`\`

Wait for every sub-worker's worker_done before reporting your own. Nesting is
capped; your sub-workers may not be able to dispatch further.

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
