import type { OrchestrationCliCommand } from './cli-command'
import type { RuntimeAgentPromptWriteOptions } from '../runtime-terminal-contracts'
import { ORCA_DISPATCH_PROMPT_LEAD_LINE } from '../../../shared/orca-dispatch-status-prompt'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/orca-session-address-prefix'

export type PreambleParams = {
  taskId: string
  // Dispatch ids fence completion authority across retries of one Task.
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

  // Use one-line recipes across POSIX/PowerShell/cmd; fence comments and use plain reasons to avoid misleading Chat rendering (STA-8200).
  const header = `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
${dispatchIdentityLines(params)}

The coordinator cannot see this ${surface}, so reach it only with the \`${cli} orchestration\`
commands below; a question or result left only in this ${surface} never gets to it.
Don't post to Slack, GitHub, or other channels during the run.
Do only this task, yourself: no subagents or helper workers unless the task asks.

=== CLI COMMANDS ===

\`\`\`sh
  # Ask the coordinator, then end your turn; Orca wakes you with the answer.
  # Never use a local question prompt such as AskUserQuestion; the
  # coordinator cannot see or answer it.
  ${cli} orchestration ask --from ${params.workerHandle} --question "<your question>" --options "<optional,comma,separated>"

  # Blocked, and the coordinator must act before you can continue:
  ${cli} orchestration send --from ${params.workerHandle} --type escalation --subject "Blocked: <reason>" --body "<details>" --task-id ${params.taskId} --dispatch-id ${params.dispatchId}

  # Finish: send exactly once. --body is three sentences: what you did, what
  # you found, what is left. Use --outcome failed if the work is not done;
  # never hide failure in prose. Add --files-modified or --report-path only
  # with real values. You are done when it confirms; if it fails, follow the
  # recovery it prints.
  ${cli} orchestration send --from ${params.workerHandle} --type worker_done --subject "<short status>" --body "<3-sentence summary: what you did, what you found, what's left>" --task-id ${params.taskId} --dispatch-id ${params.dispatchId} --outcome succeeded
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

export const TERMINAL_REDISPATCH_PARAGRAPH = `Do not exit the shell. More supervised work arrives here as a fresh preamble
and TASK block; follow it under its new Dispatch and ignore stale follow-ups.`

export const CHAT_REDISPATCH_PARAGRAPH = `More supervised work arrives in this chat as a fresh preamble and TASK
block; follow it under its new Dispatch and ignore stale follow-ups.`

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

worker_done ends your turn for this task. Do NOT start other work,
do NOT run a sleep/poll loop, and do NOT keep calling
\`${cli} orchestration check\`.

Exit the shell after completion. Bare-shell workers have no idle agent prompt
for Orca to reuse.`
  }

  return `=== AFTER YOU SEND worker_done ===

worker_done ends your turn for this task: return to an idle prompt. Do NOT
start other work, do NOT run a sleep/poll loop, and do NOT keep calling
\`${cli} orchestration check\`.

A direct instruction from the user takes precedence over this idle rule: it is
new work, so do it without the settled task or Dispatch IDs.
Never refuse a direct user request because you were a worker.

${chat ? CHAT_REDISPATCH_PARAGRAPH : TERMINAL_REDISPATCH_PARAGRAPH}`
}

// Omit disabled delegation entirely; fence placeholders and separate closing rules so Chat rendering preserves the instructions.
function buildSubDispatchSection(cli: string, workerHandle: string): string {
  return `

=== SUB-DISPATCH ===
If the task asks for helper workers, start them here. They report to you: their
questions, escalations, and worker_done arrive in your own \`check\`, next to
your coordinator's mail.

\`\`\`sh
  ${cli} orchestration worker-start --from ${workerHandle} --spec "<sub-task>" --worktree current --agent <agent> --json
  # Answer a helper's question by its message ID:
  ${cli} orchestration reply --from ${workerHandle} --id <message_id> --body "<answer>"
\`\`\`

Wait until every helper has settled (worker_done, a failed start, stop, or
abandon) before reporting your own, and name any that failed. Nesting is
capped; your helpers may not be able to start helpers of their own.

---`
}

function buildOwnRunSubDispatchSection(cli: string): string {
  return `

=== SUB-DISPATCH ===
If the task asks for sub-workers, create your own Run first, then:

\`\`\`sh
  ${cli} orchestration run-create --objective "<what the sub-workers are for>" --json
  ${cli} orchestration task-create --spec "<sub-task>" --json
  ${cli} orchestration worker-start --task <task_id> --worktree current --agent <agent> --json
\`\`\`

Wait until every sub-worker has settled (worker_done, a failed start, stop, or
abandon) before reporting your own, and name any that failed. Nesting is
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
