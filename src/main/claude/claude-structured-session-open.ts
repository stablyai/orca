import type {
  StructuredAgentSessionProviderOpenInput,
  StructuredAgentSessionProviderOpenResult
} from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { readClaudeStructuredSessionSettings } from './claude-structured-session-acquisition-options'
import { openClaudeSession, readClaudeStartupFacts } from './claude-structured-session-startup'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

/** The host awaits this under its own start signal after the process is published. */
export async function openClaudeStructuredSession(input: {
  request: StructuredAgentSessionProviderOpenInput
  session: ClaudeSession
  sessions: Map<string, ClaudeSession>
  deps: ClaudeStructuredSessionAdapterDeps
  emit: (session: ClaudeSession, event: ClaudeStructuredSessionEvent) => void
}): Promise<StructuredAgentSessionProviderOpenResult> {
  const { request, session, sessions, deps, emit } = input
  request.signal.throwIfAborted()
  if (
    session.fence !== request.fence ||
    session.acquisitionGeneration !== request.acquisitionGeneration
  ) {
    throw new Error('claude session was replaced before open')
  }
  const { proof, account, resumesTranscript, onLateRefusal } = session.initialization
  const opened = openClaudeSession({
    session,
    facts: readClaudeStartupFacts({
      connection: session.connection,
      initProof: proof,
      sessionId: request.sessionId,
      providerSessionId: session.providerSessionId,
      resumesTranscript,
      account,
      requestTimeoutMs: deps.requestTimeoutMs,
      emit: (event) => emit(session, event)
    }),
    readSettings: () =>
      readClaudeStructuredSessionSettings(session.connection, deps.requestTimeoutMs),
    isCurrent: () => sessions.get(request.sessionId) === session,
    diagnose: (diagnostic) =>
      emit(session, { type: 'auth-diagnostic', sessionId: request.sessionId, diagnostic }),
    onLateRefusal,
    report: (event) =>
      emit(session, {
        ...event,
        sessionId: request.sessionId,
        fence: session.fence,
        acquisitionGeneration: session.acquisitionGeneration
      })
  })
  const result = await waitForPromiseWithSignal(opened, request.signal)
  if (sessions.get(request.sessionId) !== session || request.signal.aborted) {
    throw new Error('claude session closed before startup completed')
  }
  return { link: session.link, ...result }
}
