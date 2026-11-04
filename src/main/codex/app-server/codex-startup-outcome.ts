import {
  agentSessionAcquireFailure,
  agentSessionStartFailure,
  type AgentSessionStartAnswer,
  type AgentSessionStartFailure
} from '../../native-chat/agent-session-wire/structured-agent-session-start-failure'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'
import { CodexAppServerExitError } from './codex-app-server-exit-error'
import { CodexAppServerFrameSizeError } from './codex-app-server-frame-size-error'

/** Codex's answer to a start request is final unless Codex declared it temporary; its transport
 *  ending with no answer once output drained is an unanswered start. */
export const codexStartupAnswer: AgentSessionStartAnswer = (cause) => {
  if (cause instanceof CodexAppServerRequestError) {
    return temporaryCodexStartupAnswer(cause) ? 'temporary' : 'final'
  }
  if (
    cause instanceof CodexAppServerUnsupportedError ||
    cause instanceof CodexAppServerFrameSizeError
  ) {
    return 'final'
  }
  if (cause instanceof CodexAppServerExitError) {
    return cause.protocolFailure ? 'final' : 'exited'
  }
  return undefined
}

export function codexStartFailure(error: unknown, exited = false): AgentSessionStartFailure {
  return agentSessionStartFailure(error, codexStartupAnswer, exited)
}

export function codexAcquireFailure(error: unknown): unknown {
  return agentSessionAcquireFailure(error, codexStartupAnswer)
}

/** Only declarations whose provider contract permits replay of a start. */
export function temporaryCodexStartupAnswer(error: CodexAppServerRequestError): boolean {
  const message = error.providerDiagnostic?.text ?? error.message
  if (error.code === -32001 && message === 'Server overloaded; retry later.') {
    return true
  }
  if (error.method !== 'thread/start' && error.method !== 'thread/resume') {
    return false
  }
  const data = typeof error.data === 'object' && error.data !== null ? error.data : {}
  if (error.code === -32600) {
    if ('reason' in data && data.reason === 'serverShuttingDown') {
      return true
    }
    if (message === 'Workspace change in progress; retry when it completes') {
      return true
    }
    if (
      error.method === 'thread/resume' &&
      /^thread .+ is closing; retry thread\/resume after the thread is closed$/.test(message)
    ) {
      return true
    }
    if (
      'reason' in data &&
      data.reason === 'cloudConfigBundle' &&
      !('action' in data && data.action === 'relogin') &&
      'errorCode' in data
    ) {
      return (
        data.errorCode === 'Timeout' ||
        (data.errorCode === 'RequestFailed' &&
          'detail' in data &&
          data.detail === 'Failed to load cloud config bundle (workspace-managed policies).')
      )
    }
  }
  return (
    error.method === 'thread/start' &&
    error.code === -32603 &&
    /^error creating thread: .*thread-store retryable error: /s.test(message)
  )
}
