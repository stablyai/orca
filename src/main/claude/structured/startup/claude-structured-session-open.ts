import { withStructuredHistoryInvocation } from '../../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-invocation'
import type {
  StructuredAgentSessionProviderOpenInput,
  StructuredAgentSessionProviderOpenResult
} from '../../../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import { readClaudeStructuredSessionSettings } from '../launch/claude-structured-session-acquisition-options'
import { openClaudeSession, readClaudeStartupFacts } from './claude-structured-session-startup'
import { catchUpClaudeTranscript } from '../../transcripts/claude-transcript-catch-up'
import { readyClaudePromptSuggestionPause } from '../claude-prompt-suggestion-pause'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from '../claude-structured-session-state'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'

type ClaudeOpenInput = {
  request: StructuredAgentSessionProviderOpenInput
  session: ClaudeSession
  sessions: Map<string, ClaudeSession>
  deps: ClaudeStructuredSessionAdapterDeps
  emit: (session: ClaudeSession, event: ClaudeStructuredSessionEvent) => void
  /** Whether a reader shows the session's prompt suggestions right now. */
  promptSuggestionsWanted?: (sessionId: string) => boolean
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
  readyClaudePromptSuggestionPause(
    session,
    input.promptSuggestionsWanted?.(request.sessionId) ?? false
  )
  // The stored leaf is set only on a resume, and is the chat's last completed turn.
  const history = session.initialization.history
  const leafUuid = history.leafUuid
  const events = session.events
  let recoverHistory: (() => Promise<void>) | undefined
  let recoveryDeadline = 0
  if (
    resumesTranscript &&
    events &&
    (leafUuid ||
      (await waitForPromiseWithSignal(
        events.journalHistory?.()?.reads.claudeRecoveryHeader({}) ?? Promise.resolve(null),
        request.signal
      )))
  ) {
    current()
    const catchUp = (recoveryDeadline?: number) =>
      withStructuredHistoryInvocation(session, request.signal, async (signal, revoke) => {
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
            ...(recoveryDeadline === undefined
              ? {}
              : { mode: 'recovery', timeoutMs: recoveryDeadline - Date.now() }),
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
      })
    const outcome = await waitForPromiseWithSignal(
      startup.race(catchUp(), request.signal),
      request.signal
    )
    history.covered = outcome === true
    if (typeof outcome === 'object') {
      recoveryDeadline = outcome.deadline
      recoverHistory = () =>
        catchUp(outcome.deadline).then((covered) => {
          history.covered = covered === true
        })
    }
    current()
  }
  startup.open()
  if (recoverHistory) {
    const settled = Promise.withResolvers<void>()
    const waiting = new AbortController()
    session.historyCatchUp = waiting
    const timer = setTimeout(() => waiting.abort(), Math.max(0, recoveryDeadline - Date.now()))
    const cancelled = () => {
      clearTimeout(timer)
      history.startRecovery = undefined
      history.recovery = undefined
      settled.resolve()
      if (session.historyCatchUp === waiting) {
        session.historyCatchUp = undefined
      }
      events?.publish()
    }
    const signal = AbortSignal.any([request.signal, waiting.signal])
    signal.addEventListener('abort', cancelled, { once: true })
    history.recovery = settled.promise
    history.startRecovery = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancelled)
      history.startRecovery = undefined
      void recoverHistory!()
        .catch((error: unknown) => {
          deps.logger?.warn('Claude transcript recovery failed', {
            scope: 'claude-transcript-catch-up',
            sessionId: request.sessionId,
            error
          })
        })
        .finally(() => {
          history.recovery = undefined
          settled.resolve()
          events?.publish()
        })
    }
    if (signal.aborted) {
      cancelled()
    }
    events?.publish()
  }
  return { ...result, link: session.link, newConversation: !resumesTranscript }
}

export function claudeHistoryStartupSettled(sessions: ReadonlyMap<string, ClaudeSession>) {
  return (sessionId: string, acquisitionGeneration: string): void => {
    const session = sessions.get(sessionId)
    if (session?.acquisitionGeneration === acquisitionGeneration) {
      session.initialization.history.startRecovery?.()
    }
  }
}
