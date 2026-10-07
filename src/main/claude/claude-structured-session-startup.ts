// What Claude reports at initialize, read in the background once the session is published. None of
// it gates the create or a message: the child was launched with the chat's saved options and takes
// input at once. Every way the start can fail (exit, auth, a foreign session id) faults the
// published session through its exit path; a CLI that never answers is ended by a Stop or a close.

import type {
  StructuredAgentSessionOptionsSkippedEvent,
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
import {
  claudeStructuredSessionPublicationOptions,
  prepareClaudeStructuredSessionAcquisitionOptions,
  readClaudeStructuredSessionSettings
} from './claude-structured-session-acquisition-options'
import { claudeRetiredOptions } from './claude-structured-retired-model'
import {
  claudeStructuredSessionOptionsFrom,
  observeClaudeSettingsApplied,
  readClaudeSettingsEffort
} from './claude-structured-session-options'
import {
  failClaudeStartup,
  type ClaudeSessionStartup
} from './claude-structured-session-startup-state'
import type { ClaudeSession, ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  admitClaudeStartFastMode,
  applyClaudeStartFastMode
} from './claude-structured-start-fast-mode'

/** The CLI's own frame naming the session it runs (system/init or a SessionStart hook). Only a
 *  SessionStart hook sends one before the first turn, so startup takes it when it came and never
 *  waits for it. */
export type ClaudeInitProof = {
  promise: Promise<ClaudeInitObservation>
  resolve: (init: ClaudeInitObservation) => void
  reject: (error: Error) => void
  /** A frame named another provider session. */
  refuse: () => void
  /** The proof seen so far, or null; throws when it was refused or the child failed first. */
  seen: () => ClaudeInitObservation | null
  /** Set once startup has read the proof: a later refusal ends the session. */
  onRefusal: ((error: Error) => void) | null
}

export function createClaudeInitProof(): ClaudeInitProof {
  let resolvePromise = (_init: ClaudeInitObservation): void => {}
  let rejectPromise = (_error: Error): void => {}
  const promise = new Promise<ClaudeInitObservation>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  void promise.catch(() => {})
  let outcome: { init: ClaudeInitObservation } | { error: Error } | null = null
  const reject = (error: Error): void => {
    outcome ??= { error }
    rejectPromise(error)
  }
  const proof: ClaudeInitProof = {
    promise,
    resolve: (init) => {
      outcome ??= { init }
      resolvePromise(init)
    },
    reject,
    refuse: () => {
      // A session already proven by its own frame keeps that proof.
      if (outcome && 'init' in outcome) {
        return
      }
      const error = new Error('claude provider session expected')
      reject(error)
      proof.onRefusal?.(error)
    },
    seen: () => {
      if (outcome && 'error' in outcome) {
        throw outcome.error
      }
      return outcome?.init ?? null
    },
    onRefusal: null
  }
  return proof
}

export type StructuredAgentSessionStartedOptions = Pick<
  StructuredAgentSessionStartedEvent,
  'reportedOptions' | 'restoreSkippedOptions' | 'retiredOptions'
>

/** A lifecycle event the start reports, before the session's identity is stamped on it. */
export type ClaudeStartupReport =
  | ({ type: 'started' } & StructuredAgentSessionStartedOptions)
  | Pick<StructuredAgentSessionOptionsSkippedEvent, 'type' | 'options'>

export type ClaudeStartupFacts = {
  init: ClaudeInitObservation | null
  initProof: ClaudeInitProof
  initialization: unknown
  settings: unknown
  prepared: ReturnType<typeof prepareClaudeStructuredSessionAcquisitionOptions>
  resumesTranscript: boolean
  requestTimeoutMs: number | undefined
}

/** Settles on the CLI's initialize answer, or on its exit or a refused proof. */
export async function readClaudeStartupFacts(input: {
  connection: ClaudeStreamJsonConnection
  initProof: ClaudeInitProof
  sessionId: string
  providerSessionId: string
  startup: Pick<ClaudeSessionStartup, 'answered'>
  resumesTranscript: boolean
  requestTimeoutMs: number | undefined
  emit: (event: ClaudeStructuredSessionEvent) => void
}): Promise<ClaudeStartupFacts> {
  // The CLI's first answer has no request deadline of its own; the reads after it do.
  const initialization = await Promise.race([
    input.connection.initializationResult().then((result) => {
      input.startup.answered = true
      const authError = claudeInitializationAuthError(result)
      if (authError) {
        throw authError
      }
      return result
    }),
    input.initProof.promise.then(() => new Promise<never>(() => {}))
  ])
  if (input.connection.closed) {
    throw new Error('claude session closed before startup completed')
  }
  input.emit({
    type: 'options',
    sessionId: input.sessionId,
    models: readClaudeModels(initialization)
  })
  input.initProof.seen()
  const settings = await readClaudeStructuredSessionSettings(
    input.connection,
    input.requestTimeoutMs
  )
  // Read again: a frame naming another session may have come during the settings read.
  const init = input.initProof.seen()
  input.emit({
    type: 'auth-diagnostic',
    sessionId: input.sessionId,
    diagnostic: claudeAuthDiagnostic(initialization, init, settings)
  })
  return {
    init,
    initProof: input.initProof,
    initialization,
    settings,
    prepared: prepareClaudeStructuredSessionAcquisitionOptions({ settings, initialization }),
    resumesTranscript: input.resumesTranscript,
    requestTimeoutMs: input.requestTimeoutMs
  }
}

function applyClaudeStartupFacts(session: ClaudeSession, facts: ClaudeStartupFacts): void {
  const { init, initialization, settings, prepared } = facts
  const effort = readClaudeSettingsEffort(settings)
  const published = claudeStructuredSessionPublicationOptions(prepared)
  // A turn's own init frame may already have reported the running model.
  if (init?.model && session.reportedOptions.model === undefined) {
    session.reportedOptions.model = init.model
    session.reportedModelMutation = session.optionMutationSequence
  }
  observeClaudeSettingsApplied(session, settings)
  // The readback vouches for a value the child was launched with only when it reports that value.
  const agrees = (key: string, reported: string): boolean =>
    !session.options.has(key) || session.options.get(key) === reported
  if (effort) {
    session.reportedOptions.effort = effort
    if (agrees('effort', effort)) {
      session.confirmedOptions.add('effort')
    }
  }
  // A launch `--effort` shows only in `applied`, never in `effective` (measured on 2.1.280).
  const launchedEffort = session.options.get('effort')
  if (launchedEffort !== undefined && session.appliedOptions?.effort === launchedEffort) {
    session.confirmedOptions.add('effort')
  }
  if (published.fastMode !== null) {
    session.reportedOptions.fastMode = published.fastMode
    if (agrees('fastMode', String(published.fastMode))) {
      session.confirmedOptions.add('fastMode')
    }
  }
  if (published.fastModePerSessionOptIn !== null) {
    session.fastModePerSessionOptIn = published.fastModePerSessionOptIn
  }
  session.fastModeState ??= published.fastModeState
  session.fastModeDisabledReason ??= published.fastModeDisabledReason
  session.capabilities = readClaudeCapabilities(session.capabilities, initialization, init?.message)
  // A catalog frame that streamed in after publish is newer than the initialize answer.
  if (session.commands.commands === undefined) {
    session.commands = new ClaudeSlashCommandCatalog(init?.message, initialization)
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

/** Applies startup facts to the published session, which already takes input. Any failure faults
 *  the session so the user sees why it never started. */
export async function settleClaudeSessionStartup(input: {
  session: ClaudeSession
  facts: Promise<ClaudeStartupFacts>
  isCurrent: () => boolean
  fault: (error: Error) => void
  /** `started` once startup has proven, with what the child now reports, snapshotted from memory;
   *  then any saved option the child showed it cannot run. */
  report: (event: ClaudeStartupReport) => void
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
    // From here no read of the proof is pending, so a frame naming another session ends it.
    facts.initProof.onRefusal = (error) => {
      failClaudeStartup(session, error)
      if (input.isCurrent()) {
        input.fault(error)
      }
    }
    applyClaudeStartupFacts(session, facts)
    const startFastMode = admitClaudeStartFastMode(session, facts)
    if (!superseded()) {
      input.report({
        type: 'started',
        // `list_models` is answered from this same initialize result, so nothing is re-read.
        reportedOptions: claudeStartedReportedOptions(
          session,
          readClaudeModels(facts.initialization)
        ),
        restoreSkippedOptions: [...session.restoreSkippedOptions],
        ...claudeRetiredOptions(session)
      })
      if (session.startup.state === 'pending') {
        session.startup.state = 'proven'
      }
      if (startFastMode !== null) {
        void applyClaudeStartFastMode(session, facts, startFastMode, (event) => {
          if (input.isCurrent()) {
            input.report(event)
          }
        })
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
