import {
  isLinearAuthError,
  getLinearIssueCommentThreadRoot
} from './runtime-linear-command-dependencies'
import {
  LinearAgentAccessError,
  linearError,
  toLinearAccessError
} from '../linear/issue-context/errors'
import { runLinearWriteAction } from './runtime-linear-write-action'
import type { LinearWriteFailure } from '../linear/linear-issue-write-support'
import { RuntimeLinearWriteResultCommands } from './runtime-linear-write-result-commands'

export class RuntimeLinearCommentLookupCommands extends RuntimeLinearWriteResultCommands {
  public async resolveLinearCommentParentId(
    issueId: string,
    commentId: string,
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<string> {
    signal?.throwIfAborted()
    try {
      const root = await getLinearIssueCommentThreadRoot(issueId, commentId, workspaceId, signal)
      if (!root) {
        throw linearError(
          'linear_invalid_parent',
          'The reply target is not a comment on this issue.',
          {
            nextSteps: ['Run `orca linear issue <id> --comments --json` to list valid comment ids.']
          }
        )
      }
      return root.id
    } catch (error) {
      if (error instanceof LinearAgentAccessError) {
        throw error
      }
      throw this.mapLinearReadFailure(error)
    }
  }

  public runLinearAgentAction<Owner, Result>(
    prepare: (signal: AbortSignal) => Promise<Owner>,
    write: (
      owner: Owner,
      options: { signal: AbortSignal; beforeInvoke: () => void }
    ) => Promise<Result>,
    unconfirmed: (owner: Owner, cause?: string) => LinearAgentAccessError,
    cancellation?: AbortSignal,
    mapWriteFailure?: (error: LinearWriteFailure) => LinearAgentAccessError
  ): Promise<{ owner: Owner; result: Result }> {
    return runLinearWriteAction(
      prepare,
      write,
      unconfirmed,
      (error) => this.mapLinearReadFailure(error),
      cancellation,
      mapWriteFailure
    )
  }

  public mapLinearCommentWriteFailure(error: LinearWriteFailure): LinearAgentAccessError {
    return linearError(
      error.kind === 'network' ? 'linear_network_error' : 'linear_write_failed',
      'Linear could not complete the comment change. Retry after checking the comment.'
    )
  }

  public mapLinearReadFailure(error: unknown): LinearAgentAccessError {
    if (error instanceof LinearAgentAccessError) {
      return error
    }
    if (isLinearAuthError(error)) {
      return linearError('linear_auth_expired', 'Linear authentication expired.', {
        nextSteps: ['Reconnect Linear from Orca settings.']
      })
    }
    return toLinearAccessError(error)
  }
}
