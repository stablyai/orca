import type { AgentLaunchFailureCode } from '../../../src/shared/agent-launch-contract'

export type TaskWorkspaceCreatedResult = {
  worktree: { id: string; displayName?: string }
  warning?: string
}

export function readTaskWorkspaceCreatedResult(result: unknown): TaskWorkspaceCreatedResult {
  if (!result || typeof result !== 'object') {
    throw new Error('Created workspace response was invalid')
  }
  const value = result as
    | TaskWorkspaceCreatedResult
    | {
        agentLaunchResult?:
          | { status: 'failed'; failure: { code: AgentLaunchFailureCode } }
          | { status: 'rejected'; requestError: { code: string } }
      }
  if ('worktree' in value && typeof value.worktree?.id === 'string') {
    return value
  }
  const agentLaunchResult = 'agentLaunchResult' in value ? value.agentLaunchResult : undefined
  if (agentLaunchResult?.status === 'failed') {
    throw new Error(`Couldn't start the agent (${agentLaunchResult.failure.code}).`)
  }
  if (agentLaunchResult?.status === 'rejected') {
    throw new Error(`Couldn't create the workspace (${agentLaunchResult.requestError.code}).`)
  }
  throw new Error('Created workspace response was invalid')
}
