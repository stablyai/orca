import { AgentSessionAcquisitionExitUnprovenError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { isCodexAppServerHandshakeExitUnprovenError } from './codex-app-server-handshake-exit-proof'
import {
  cancelCodexAcquisitionAttempt,
  type CodexAcquisitionAttempt,
  type CodexAcquisitionRegistry
} from './codex-structured-session-state'

export async function stopSupersededCodexAcquisition(input: {
  sessionId: string
  registry: CodexAcquisitionRegistry
  replacement: CodexAcquisitionAttempt
  previous: CodexAcquisitionAttempt | undefined
}): Promise<void> {
  try {
    if (!(await cancelCodexAcquisitionAttempt(input.previous))) {
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(`codex acquisition for session ${input.sessionId} could not be stopped`)
      )
    }
  } catch (error) {
    if (input.previous) {
      input.registry.restoreIfCurrent(input.sessionId, input.replacement, input.previous)
    }
    throw error
  }
}

export async function closeFailedCodexAcquisition(input: {
  sessionId: string
  registry: CodexAcquisitionRegistry
  attempt: CodexAcquisitionAttempt
  cause: unknown
  dispose: () => void
}): Promise<never> {
  if (isCodexAppServerHandshakeExitUnprovenError(input.cause)) {
    input.attempt.window.connection = input.cause.connection
  }
  input.dispose()
  try {
    if (!(await input.registry.closeFailedAttempt(input.sessionId, input.attempt))) {
      throw new AgentSessionAcquisitionExitUnprovenError(input.cause)
    }
  } catch (cleanupError) {
    if (cleanupError instanceof AgentSessionAcquisitionExitUnprovenError) {
      throw cleanupError
    }
    throw new AgentSessionAcquisitionExitUnprovenError(
      new AggregateError([input.cause, cleanupError], 'codex acquisition cleanup failed')
    )
  }
  throw input.cause
}
