import type { OrchestrationCliCommand } from '../cli-command'

/** B5 — the runtime, not the model, owns the worker's protocol context.
 *
 *  Everything a worker needs to address the control plane is bound here at
 *  dispatch time: Task, Dispatch, coordinator, capability and the Run/outcome
 *  identity. The model never assembles those ids itself and never composes a
 *  lifecycle command line from parts — it invokes one typed operation.
 *
 *  Fresh vs retained: a fresh worker gets the concise static bootstrap once. A
 *  retained worker already ran it, so re-engagement sends only the delta (the
 *  ids that changed) plus the task — never the lifecycle manual again.
 */

export type WorkerProtocolIdentity = {
  taskId: string
  dispatchId: string
  runId: string | null
  outcomeId: string | null
  coordinatorHandle: string
  workerHandle: string
  dispatchCapability?: string
}

export type WorkerOperationName = 'report' | 'ask' | 'escalate'

export type WorkerOperation = {
  name: WorkerOperationName
  /** Fully bound invocation; the model fills only the free-text arguments. */
  invocation: string
  purpose: string
}

export type WorkerProtocolContext = WorkerProtocolIdentity & {
  cli: OrchestrationCliCommand | 'orca-dev'
  operations: Record<WorkerOperationName, WorkerOperation>
}

export function buildWorkerProtocolContext(args: {
  identity: WorkerProtocolIdentity
  cli: OrchestrationCliCommand | 'orca-dev'
}): WorkerProtocolContext {
  const { identity, cli } = args
  // Why --from is explicit: focus is not lifecycle authority; the operation
  // must name the dispatched terminal.
  const bind = `--from ${identity.workerHandle} --task ${identity.taskId} --dispatch ${identity.dispatchId}`
  const capability = identity.dispatchCapability
    ? ` --dispatch-capability ${identity.dispatchCapability}`
    : ''
  const outcomeBinding = `${identity.runId ? ` --run ${identity.runId}` : ''}${
    identity.outcomeId ? ` --outcome-id ${identity.outcomeId}` : ''
  }`
  return {
    ...identity,
    cli,
    operations: {
      report: {
        name: 'report',
        invocation: `${cli} orchestration report ${bind}${capability}${outcomeBinding} --outcome <succeeded|failed> --body "<3-sentence summary>"`,
        purpose: 'Report the terminal task outcome. Exactly once, and only once.'
      },
      ask: {
        name: 'ask',
        invocation: `${cli} orchestration ask --from ${identity.workerHandle}${capability} --question "<question>"`,
        purpose: 'Ask the coordinator and block until it answers.'
      },
      escalate: {
        name: 'escalate',
        invocation: `${cli} orchestration escalate ${bind}${capability} --subject "<blocker>" --body "<details>"`,
        purpose: 'Raise a blocker you cannot resolve, before completing.'
      }
    }
  }
}

/** Concise static bootstrap for a fresh worker. Deliberately short: the long
 *  form trained workers to skim, and every rule that survives here is one the
 *  runtime cannot enforce on its own. */
export function renderWorkerBootstrap(context: WorkerProtocolContext): string {
  const identity = [
    `Task: ${context.taskId}`,
    `Dispatch: ${context.dispatchId}`,
    context.runId ? `Run: ${context.runId}` : null,
    context.outcomeId ? `Outcome: ${context.outcomeId}` : null,
    `Coordinator: ${context.coordinatorHandle}`
  ]
    .filter(Boolean)
    .join('\n')

  return `You are a dispatched worker inside Orca. The runtime owns your lifecycle;
these three operations are the only channel to your coordinator. Do not use
Slack, GitHub comments, or any other channel to reach a human during the run.

${identity}

=== OPERATIONS ===

  # ${context.operations.report.purpose}
  # --body is a 3-sentence executive summary: what you did, what you found,
  # what is left. Add --files-modified and --report-path when they exist.
  ${context.operations.report.invocation}

  # ${context.operations.ask.purpose}
  # NEVER use AskUserQuestion — it opens a local prompt your coordinator
  # cannot see, and your session hangs forever.
  ${context.operations.ask.invocation}

  # ${context.operations.escalate.purpose}
  ${context.operations.escalate.invocation}

Orca tracks your liveness from your own process and session state. You do not
send liveness signals and you do not poll for messages.`
}

/** Re-engagement delta for a retained worker: only what changed. */
export function renderRetainedDispatchDelta(args: {
  context: WorkerProtocolContext
  previous: { taskId: string; dispatchId: string }
}): string {
  const { context, previous } = args
  const changed: string[] = []
  if (previous.taskId !== context.taskId) {
    changed.push(`Task: ${previous.taskId} -> ${context.taskId}`)
  }
  changed.push(`Dispatch: ${previous.dispatchId} -> ${context.dispatchId}`)
  if (context.outcomeId) {
    changed.push(`Outcome: ${context.outcomeId}`)
  }
  return `=== NEW DISPATCH ===
${changed.join('\n')}

Report with:
  ${context.operations.report.invocation}`
}
