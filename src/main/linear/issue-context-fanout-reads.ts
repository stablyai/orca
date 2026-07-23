import { runBoundedIntegrationSettledFanout } from '../integration-fanout'
import { boundedIntegrationErrorLog } from '../integration-error-message'
import type { LinearClientForWorkspace } from './client'
import { LinearAgentAccessError } from './issue-context-errors'
import { workspaceFailure, type WorkspaceReadFailure } from './issue-context-fanout'

export async function readLinearIssueWorkspaceFanout<TResult>(
  entries: LinearClientForWorkspace[],
  selection: string | 'all',
  readWorkspace: (entry: LinearClientForWorkspace) => Promise<TResult | null>,
  initialFailures: WorkspaceReadFailure[] = []
): Promise<{ results: TResult[]; truncated: boolean }> {
  if (selection !== 'all') {
    const selected = await readWorkspace(entries[0])
    return { results: selected ? [selected] : [], truncated: false }
  }

  const fanout = await runBoundedIntegrationSettledFanout(entries, readWorkspace, (result) =>
    result ? [result] : []
  )
  const results: TResult[] = []
  const failures: LinearAgentAccessError[] = initialFailures.map((failure) => failure.error)

  for (const result of fanout.results) {
    if (result.status === 'fulfilled') {
      if (result.value) {
        results.push(result.value)
      }
      continue
    }
    if (result.reason instanceof LinearAgentAccessError) {
      failures.push(result.reason)
    }
    console.warn('[linear] agent issue read failed:', boundedIntegrationErrorLog(result.reason))
  }

  if (fanout.truncated) {
    console.warn('[linear] Agent issue fan-out exceeded its aggregate result budget; truncating.')
  }
  if (results.length === 0 && failures[0] && !fanout.truncated) {
    throw failures[0]
  }
  return { results, truncated: fanout.truncated }
}

export async function readLinearSearchWorkspaceFanout<TResult>(
  entries: LinearClientForWorkspace[],
  workspaceId: string | 'all' | undefined,
  readWorkspace: (entry: LinearClientForWorkspace) => Promise<TResult[]>,
  initialFailures: WorkspaceReadFailure[] = []
): Promise<{
  results: TResult[][]
  failures: WorkspaceReadFailure[]
  truncated: boolean
}> {
  if (workspaceId && workspaceId !== 'all') {
    return {
      results: [await readWorkspace(entries[0])],
      failures: [],
      truncated: false
    }
  }

  const fanout = await runBoundedIntegrationSettledFanout(
    entries,
    readWorkspace,
    (results) => results
  )
  const attemptedWorkspaceCount = fanout.attemptedCount + initialFailures.length
  const results: TResult[][] = []
  const failures: WorkspaceReadFailure[] = [...initialFailures]
  for (let index = 0; index < fanout.results.length; index += 1) {
    const result = fanout.results[index]
    if (result.status === 'fulfilled') {
      results.push(result.value)
      continue
    }
    if (result.reason instanceof LinearAgentAccessError) {
      failures.push(workspaceFailure(entries[index].workspace, result.reason))
    }
    console.warn('[linear] agent search failed:', boundedIntegrationErrorLog(result.reason))
  }

  if (fanout.truncated) {
    console.warn('[linear] Agent search fan-out exceeded its aggregate result budget; truncating.')
  }
  if (
    results.length === 0 &&
    failures.length === attemptedWorkspaceCount &&
    failures[0] &&
    !fanout.truncated
  ) {
    throw failures[0].error
  }
  return { results, failures, truncated: fanout.truncated }
}
