import { usableJournalHistoryOrigin } from '../../native-chat/agent-session-journal/context-epochs/journal-history-origin'
import type {
  StructuredAgentSessionProviderOpenInput,
  StructuredAgentSessionProviderOpenResult
} from '../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { readClaudeStructuredSessionSettings } from './launch/claude-structured-session-acquisition-options'
import { openClaudeSession, readClaudeStartupFacts } from './claude-structured-session-startup'
import { readClaudeRemoteControlAutoEnable } from './claude-structured-init-proof'
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
  const facts =
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
    })
  const opened = openClaudeSession({
    session,
    facts,
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
  // Settled: the open above resolves only after these facts do.
  const remoteControl = readClaudeRemoteControlAutoEnable((await facts).initialization)
  const current = () => {
    if (sessions.get(request.sessionId) !== session || request.signal.aborted) {
      throw new Error('claude session closed before startup completed')
    }
  }
  current()
  // The stored leaf is set only on a resume, and is the chat's last completed turn.
  const history = session.initialization.history
  const leafUuid = history.leafUuid
  const origin = usableJournalHistoryOrigin(
    session.events?.journalHistory?.()?.historyOrigin() ?? null
  )
  if (resumesTranscript && (leafUuid || origin?.kind === 'native_copy') && session.events) {
    const catchUp = catchUpClaudeTranscript({
      sessionId: request.sessionId,
      providerSessionId: session.providerSessionId,
      leafUuid: leafUuid ?? '',
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
    })
    history.covered = await waitForPromiseWithSignal(
      startup.race(catchUp, request.signal),
      request.signal
    )
    current()
  }
  startup.open()
  // After catch-up, so a turn sent from the phone cannot race the transcript catch-up.
  if (remoteControl) {
    connectClaudeRemoteControl(session, request.sessionId, deps)
  }
  return { ...result, link: session.link, newConversation: !resumesTranscript }
}

/** Mirrors a terminal session's auto-connect; a refusal leaves the chat working without it. */
function connectClaudeRemoteControl(
  session: ClaudeSession,
  sessionId: string,
  deps: ClaudeStructuredSessionAdapterDeps
): void {
  void session.connection
    .enableRemoteControl({ timeoutMs: deps.requestTimeoutMs })
    .catch((error: unknown) => {
      if (!session.connection.closed) {
        deps.logger?.warn('connecting a Claude chat to Remote Control failed', {
          scope: 'claude-remote-control',
          sessionId,
          error
        })
      }
    })
}
