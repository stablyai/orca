// Codex rollout JSONL records, as Codex writes them, for the rollout read tests.

export const ROOT_ID = '019fa65f-0000-7000-8000-000000000001'

export const event = (payload: Record<string, unknown>): string =>
  `${JSON.stringify({ type: 'event_msg', payload })}
`
export const sessionMeta = (cliVersion: string): string =>
  `${JSON.stringify({ type: 'session_meta', payload: { id: ROOT_ID, cli_version: cliVersion } })}
`
export const childMeta = (id: string, agentPath: string): string =>
  `${JSON.stringify({
    type: 'session_meta',
    payload: { id, source: { subagent: { thread_spawn: { agent_path: agentPath } } } }
  })}
`
export const turnContext = (turnId: string, reviewer: 'user' | 'auto_review'): string =>
  `${JSON.stringify({ type: 'turn_context', payload: { turn_id: turnId, approvals_reviewer: reviewer } })}
`
export const taskStarted = (turnId: string): string =>
  event({ type: 'task_started', turn_id: turnId })
export const taskComplete = (turnId: string, error?: unknown): string =>
  event({ type: 'task_complete', turn_id: turnId, error: error ?? null })
export const turnAborted = (turnId: string): string =>
  event({ type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' })

export const BASH = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'call-1' }
