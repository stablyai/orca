import type { CodexAppServerRequestError } from './codex-app-server-request-error'

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
