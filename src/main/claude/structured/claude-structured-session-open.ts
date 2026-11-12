import { withStructuredHistoryInvocation } from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-invocation'
import { usableJournalHistoryOrigin } from '../../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import type {
  StructuredAgentSessionProviderOpenInput,
  StructuredAgentSessionProviderOpenResult
} from '../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { readClaudeStructuredSessionSettings } from './launch/claude-structured-session-acquisition-options'
import { openClaudeSession, readClaudeStartupFacts } from './claude-structured-session-startup'
import { catchUpClaudeTranscript } from '../transcripts/claude-transcript-catch-up'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

type ClaudeOpenInput = {
  request: StructuredAgentSessionProviderOpenInput
  session: ClaudeSession
  sessions: Map<string, ClaudeSession>
  deps: ClaudeStructuredSessionAdapterDeps
  emit: (session: ClaudeSession, event: ClaudeStructuredSessionEvent) => void
}

export async function openClaudeStructuredSession(
  input: ClaudeOpenInput
): Promise<StructuredAgentSessionProviderOpenResult> {
  const { request, session } = input
  request.signal.throwIfAborted()
  if (
    session.fence !== request.fence ||
    session.acquisitionGeneration !== request.acquisitionGeneration
  ) {
    throw new Error('claude session was replaced before open')
  }
  try {
    return await openStartingClaudeSession(input)
  } catch (error) {
    // The start's first ending cause is its report; a Stop stays Stop, so a later result is still taken.
    throw request.signal.aborted ? error : session.initialization.startup.fail(error)
  }
}

async function openStartingClaudeSession(
  input: ClaudeOpenInput
): Promise<StructuredAgentSessionProviderOpenResult> {
  const { request, session, sessions, deps, emit } = input
  const { proof, account, resumesTranscript, onLateRefusal, startup } = session.initialization
  const opened = openClaudeSession({
    session,
    facts:
      session.initialization.facts ??
      readClaudeStartupFacts({
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
  // A failure Claude reports while initialize or catch-up is pending fails this open at once.
  const result = await waitForPromiseWithSignal(
    startup.race(opened, request.signal),
    request.signal
  )
  const current = () => {
    if (sessions.get(request.sessionId) !== session || request.signal.aborted) {
      throw new Error('claude session closed before startup completed')
    }
  }
  current()
  // The stored leaf is set only on a resume, and is the chat's last completed turn.
  const history = session.initialization.history
  const leafUuid = history.leafUuid
  const events = session.events
  const origin = usableJournalHistoryOrigin(
    (await events?.journalHistory?.()?.reads.historyOrigin()) ?? null
  )
  if (resumesTranscript && (leafUuid || origin?.kind === 'native_copy') && events) {
    const catchUp = withStructuredHistoryInvocation(
      session,
      request.signal,
      async (signal, revoke) => {
        const release = session.translator?.subscribeContextActivity(revoke)
        try {
          return await catchUpClaudeTranscript({
            sessionId: request.sessionId,
            providerSessionId: session.providerSessionId,
            leafUuid: leafUuid ?? '',
            claudeConfigDir: session.initialization.claudeConfigDir,
            cwd: session.initialization.cwd,
            sink: events,
            signal,
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
          })
        } finally {
          release?.()
        }
      }
    )
    history.covered = await waitForPromiseWithSignal(
      startup.race(catchUp, request.signal),
      request.signal
    )
    current()
  }
  startup.open()
  return { ...result, link: session.link, newConversation: !resumesTranscript }
}
