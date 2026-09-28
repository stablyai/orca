// What Claude reports at initialize, read after the session is already published. None of it
// gates the create: a slow start is still a start, and every way it can fail (exit, auth,
// a foreign session id) faults the published session through its exit path.

import type {
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionStartedEvent
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'
import {
  claudeAuthDiagnostic,
  claudeInitializationAuthError,
  readClaudeCapabilities,
  readClaudeModels,
  type ClaudeInitObservation
} from './claude-structured-init-proof'
import { restoreClaudeStructuredSessionOptions } from './claude-structured-options'
import {
  claudeStructuredSessionPublicationOptions,
  prepareClaudeStructuredSessionAcquisitionOptions,
  readClaudeStructuredSessionSettings
} from './claude-structured-session-acquisition-options'
import {
  claudeStructuredSessionOptionsFrom,
  observeClaudeSettingsApplied,
  readClaudeSettingsEffort
} from './claude-structured-session-options'
import { failClaudeStartup } from './claude-structured-session-startup-state'
import type { ClaudeSession, ClaudeStructuredSessionEvent } from './claude-structured-session-state'

export type ClaudeInitProof = {
  promise: Promise<ClaudeInitObservation>
  resolve: (init: ClaudeInitObservation) => void
  reject: (error: Error) => void
}

export function createClaudeInitProof(): ClaudeInitProof {
  let resolve = (_init: ClaudeInitObservation): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<ClaudeInitObservation>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

export type StructuredAgentSessionStartedOptions = Pick<
  StructuredAgentSessionStartedEvent,
  'reportedOptions' | 'restoreSkippedOptions'
>

export type ClaudeStartupFacts = {
  init: ClaudeInitObservation
  initialization: unknown
  settings: unknown
  prepared: ReturnType<typeof prepareClaudeStructuredSessionAcquisitionOptions>
}

/** Settles on the CLI's answers or on its exit; there is no startup timer. */
export async function readClaudeStartupFacts(input: {
  connection: ClaudeStreamJsonConnection
  initProof: ClaudeInitProof
  sessionId: string
  providerSessionId: string
  resumesTranscript: boolean
  inputOptions: StructuredAgentSessionAcquireInput['options']
  requestTimeoutMs: number | undefined
  emit: (event: ClaudeStructuredSessionEvent) => void
}): Promise<ClaudeStartupFacts> {
  const [initialization, init] = await Promise.all([
    input.connection.initializationResult().then((result) => {
      const authError = claudeInitializationAuthError(result)
      if (authError) {
        throw authError
      }
      return result
    }),
    input.initProof.promise
  ])
  if (input.connection.closed) {
    throw new Error('claude session closed before startup completed')
  }
  input.emit({
    type: 'options',
    sessionId: input.sessionId,
    models: readClaudeModels(initialization)
  })
  if (init.providerSessionId !== input.providerSessionId) {
    throw new Error(
      `claude proved session ${init.providerSessionId}, expected ${input.providerSessionId}`
    )
  }
  const settings = await readClaudeStructuredSessionSettings(
    input.connection,
    input.requestTimeoutMs
  )
  input.emit({
    type: 'auth-diagnostic',
    sessionId: input.sessionId,
    diagnostic: claudeAuthDiagnostic(init, settings)
  })
  return {
    init,
    initialization,
    settings,
    prepared: prepareClaudeStructuredSessionAcquisitionOptions({
      settings,
      initialization,
      inputOptions: input.inputOptions,
      resumesTranscript: input.resumesTranscript
    })
  }
}

function applyClaudeStartupFacts(session: ClaudeSession, facts: ClaudeStartupFacts): void {
  const { init, initialization, settings, prepared } = facts
  const effort = readClaudeSettingsEffort(settings)
  const published = claudeStructuredSessionPublicationOptions(prepared)
  // A turn's own init frame may already have reported the running model.
  if (init.model && session.reportedOptions.model === undefined) {
    session.reportedOptions.model = init.model
    session.reportedModelMutation = session.optionMutationSequence
  }
  observeClaudeSettingsApplied(session, settings)
  if (effort) {
    session.reportedOptions.effort = effort
    session.confirmedOptions.add('effort')
  }
  if (published.fastMode !== null) {
    session.reportedOptions.fastMode = published.fastMode
    session.confirmedOptions.add('fastMode')
  }
  if (published.fastModePerSessionOptIn !== null) {
    session.fastModePerSessionOptIn = published.fastModePerSessionOptIn
  }
  session.fastModeState ??= published.fastModeState
  session.fastModeDisabledReason ??= published.fastModeDisabledReason
  session.options = prepared.options
  session.capabilities = readClaudeCapabilities(init, initialization)
  // A catalog frame that streamed in after publish is newer than the initialize answer.
  if (session.commands.commands === undefined) {
    session.commands = new ClaudeSlashCommandCatalog(init.message, initialization)
  }
  session.events?.publish()
}

/** What the start persists as the session's options. The applied effort is display-only: saved,
 *  it would pin an effort nobody chose on every reopen, past a later settings change. */
function claudeStartedReportedOptions(
  session: ClaudeSession,
  catalog: unknown[]
): StructuredAgentSessionStartedOptions['reportedOptions'] {
  const { current } = claudeStructuredSessionOptionsFrom(session, catalog)
  if (session.options.has('effort') || session.reportedOptions.effort !== undefined) {
    return current
  }
  const { effort: _displayOnly, ...persisted } = current
  return persisted
}

/** Applies startup facts to the published session and restores saved options; only then does the
 *  session take input. Any failure faults the session so the user sees why it never started. */
export async function settleClaudeSessionStartup(input: {
  session: ClaudeSession
  facts: Promise<ClaudeStartupFacts>
  isCurrent: () => boolean
  requestTimeoutMs: number | undefined
  fault: (error: Error) => void
  /** Startup has proven; `options` is what the child now reports, snapshotted from memory. */
  onStarted: (options: StructuredAgentSessionStartedOptions) => void
}): Promise<void> {
  const { session } = input
  const superseded = (): boolean => {
    if (input.isCurrent()) {
      return false
    }
    failClaudeStartup(session, new Error('claude session closed before startup completed'))
    return true
  }
  try {
    const facts = await input.facts
    if (superseded()) {
      return
    }
    applyClaudeStartupFacts(session, facts)
    await restoreClaudeStructuredSessionOptions(session, input.requestTimeoutMs)
    if (!superseded()) {
      input.onStarted({
        // `list_models` is answered from this same initialize result, so nothing is re-read.
        reportedOptions: claudeStartedReportedOptions(
          session,
          readClaudeModels(facts.initialization)
        ),
        restoreSkippedOptions: [...session.restoreSkippedOptions]
      })
      if (session.startup.state === 'pending') {
        session.startup.state = 'proven'
      }
    }
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught))
    // A close or exit that already ended startup owns how the session ends.
    const endedElsewhere = session.startup.state !== 'pending'
    failClaudeStartup(session, error)
    if (!endedElsewhere && input.isCurrent()) {
      input.fault(error)
    }
  }
}
