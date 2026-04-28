export type PreambleParams = {
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  devMode?: boolean
}

// Why: the dispatch preamble teaches agents about Orca's CLI commands for
// structured communication. Agents don't need prior knowledge of Orca — they
// treat these as shell tools the same way they use git or npm.
export function buildDispatchPreamble(params: PreambleParams): string {
  // Why: in dev mode, agents must use orca-dev to connect to the dev runtime's
  // socket. Without this, agents inside the dev Electron app would call the
  // production CLI and talk to the wrong Orca instance (Section 6.4).
  const cli = params.devMode ? 'orca-dev' : 'orca'

  return `You are working inside Orca, a multi-agent IDE. You have access to these
CLI commands for communicating with the coordinator:

  # Report task completion (REQUIRED when done):
  ${cli} orchestration send --to ${params.coordinatorHandle} \\
    --type worker_done --subject "Done" \\
    --payload '{"taskId":"${params.taskId}","filesModified":[...]}'

  # Report a blocker or failure:
  ${cli} orchestration send --to ${params.coordinatorHandle} \\
    --type escalation --subject "Blocked: <reason>" \\
    --body "<details>"

  # Check for messages from the coordinator or other agents:
  ${cli} orchestration check

Your assigned task ID is: ${params.taskId}

When you finish your task, run the worker_done command above with the
list of files you modified. If you are blocked or need help, send an
escalation. Do not exit the session.

--- TASK ---
${params.taskSpec}`
}
