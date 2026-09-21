import type { ClaudeInitObservation } from './claude-structured-init-proof'
import { claudeInitializationAuthError } from './claude-structured-init-proof'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export type ClaudeInitDeadline = {
  promise: Promise<ClaudeInitObservation>
  resolve: (init: ClaudeInitObservation) => void
  reject: (error: Error) => void
  start: () => void
  clear: () => void
}

export function claudeInitTimeoutError(
  sessionId: string,
  timeoutMs: number
): AgentSessionAcquisitionRefusal {
  return new AgentSessionAcquisitionRefusal(
    `Claude did not finish starting session ${sessionId} within ${Math.ceil(timeoutMs / 1000)} seconds. Verify the selected Claude account is signed in and CLAUDE_CONFIG_DIR contains valid credentials, then retry; no SessionStart or system/init proof arrived.`
  )
}

export async function requestClaudeInitialization(
  connection: ClaudeStreamJsonConnection,
  sessionId: string,
  timeoutMs: number
): Promise<unknown> {
  try {
    const result = await connection.initializationResult({ timeoutMs })
    const authError = claudeInitializationAuthError(result)
    if (authError) {
      throw authError
    }
    return result
  } catch (error) {
    if (error instanceof Error && error.message === 'claude initialize request timed out') {
      throw claudeInitTimeoutError(sessionId, timeoutMs)
    }
    throw error
  }
}

export function createClaudeInitDeadline(sessionId: string, timeoutMs: number): ClaudeInitDeadline {
  let resolve = (_init: ClaudeInitObservation): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<ClaudeInitObservation>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  void promise.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | null = null

  return {
    promise,
    resolve,
    reject,
    start: () => {
      timer = setTimeout(() => reject(claudeInitTimeoutError(sessionId, timeoutMs)), timeoutMs)
      timer.unref?.()
    },
    clear: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
