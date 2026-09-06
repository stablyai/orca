import {
  isLinearAuthError,
  getLinearIssueCommentThreadRoot,
  LinearWriteFailure,
  LinearAgentAccessError,
  classifyLinearError,
  linearError,
  linearMessage,
  sanitizeLinearErrorMessage
} from './runtime-linear-command-dependencies'
import { RuntimeLinearWriteResultCommands } from './runtime-linear-write-result-commands'

export class RuntimeLinearCommentLookupCommands extends RuntimeLinearWriteResultCommands {
  public async resolveLinearCommentParentId(
    issueId: string,
    commentId: string,
    workspaceId: string
  ): Promise<string> {
    try {
      const root = await getLinearIssueCommentThreadRoot(issueId, commentId, workspaceId)
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

  public async runLinearAgentWrite<T>(
    write: (signal: AbortSignal) => Promise<T>,
    unconfirmed: (cause?: string) => LinearAgentAccessError
  ): Promise<T> {
    const controller = new AbortController()
    const writePromise = write(controller.signal)
    writePromise.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        writePromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(
              new LinearWriteFailure(
                'unconfirmed',
                'Linear write deadline elapsed before confirmation.'
              )
            )
          }, 25_000)
        })
      ])
    } catch (error) {
      if (error instanceof LinearWriteFailure && error.kind === 'duplicate_id') {
        throw error
      }
      if (error instanceof LinearWriteFailure && error.kind === 'unconfirmed') {
        throw unconfirmed(this.linearWriteFailureCauseMessage(error))
      }
      if (error instanceof LinearWriteFailure && error.kind === 'network') {
        throw linearError('linear_network_error', sanitizeLinearErrorMessage(error.message))
      }
      if (error instanceof LinearWriteFailure) {
        throw linearError('linear_write_failed', sanitizeLinearErrorMessage(error.message))
      }
      throw this.mapLinearReadFailure(error)
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  public linearWriteFailureCauseMessage(error: LinearWriteFailure): string {
    if (error.cause instanceof Error) {
      return sanitizeLinearErrorMessage(error.cause.message)
    }
    if (error.cause !== undefined) {
      return sanitizeLinearErrorMessage(String(error.cause))
    }
    return sanitizeLinearErrorMessage(error.message)
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
    return linearError(classifyLinearError(error), linearMessage(error))
  }
}
