import type {
  StructuredAgentSessionProviderOpenInput,
  StructuredAgentSessionProviderOpenResult
} from '../../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { readClaudeStructuredSessionSettings } from '../claude-structured-session-acquisition-options'
import { openClaudeSession, readClaudeStartupFacts } from './claude-structured-session-startup'
import { catchUpClaudeTranscript } from '../claude-transcript-catch-up'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

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
  const current = () => {
    if (sessions.get(request.sessionId) !== session || request.signal.aborted) {
      throw new Error('claude session closed before startup completed')
    }
  }
  current()
  // The stored leaf is set only on a resume, and is the chat's last completed turn.
  const history = session.initialization.history
  const leafUuid = history.leafUuid
  if (resumesTranscript && leafUuid && session.events) {
    history.covered = await waitForPromiseWithSignal(
      catchUpClaudeTranscript({
        sessionId: request.sessionId,
        providerSessionId: session.providerSessionId,
        leafUuid,
        claudeConfigDir: session.initialization.claudeConfigDir,
        cwd: session.initialization.cwd,
        sink: session.events,
        signal: request.signal,
        assertCurrent: () => {
          current()
          if (
            session.translator?.contextActivity !== history.contextActivity ||
            session.dispatchSequence !== 0
          ) {
            throw new Error('claude made live progress before catch-up completed')
          }
        },
        ...(deps.logger ? { logger: deps.logger } : {})
      }),
      request.signal
    )
    current()
  }
  return { link: session.link, ...result }
}
