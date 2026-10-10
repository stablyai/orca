// What Claude reports at initialize, read once the session is published. The initialize answer is
// the start: `started` follows it, and the host hands the child nothing before. The settings read
// after it is optional and never delays that; what it reports is applied as a later options update.
// Every way the start can fail (exit, auth, a foreign session id) faults the published session
// through its exit path; one that stops making progress is ended by the host's startup limit.

import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
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
  type ClaudeInitObservation,
  type ClaudeInitProof
} from './claude-structured-init-proof'
import {
  claudeStructuredSessionPublicationOptions,
  prepareClaudeStructuredSessionAcquisitionOptions
} from './claude-structured-session-acquisition-options'
import { claudeRetiredOptions } from './claude-structured-retired-model'
import {
  claudeResolvedCatalogListing,
  claudeStructuredSessionOptionsFrom,
  observeClaudeSettingsApplied,
  readClaudeFastModeFacts,
  readClaudeSettingsEffort
} from './claude-structured-session-options'
import {
  failClaudeStartup,
  type ClaudeSessionStartup
} from './claude-structured-session-startup-state'
import type {
  ClaudeAuthDiagnostic,
  ClaudeSession,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'
import {
  admitClaudeStartFastMode,
  applyClaudeStartFastMode
} from './claude-structured-start-fast-mode'

export type StructuredAgentSessionStartedOptions = Pick<
  StructuredAgentSessionStartedEvent,
  | 'reportedOptions'
  | 'restoreSkippedOptions'
  | 'retiredOptions'
  | 'optionRevision'
  | 'catalogListing'
>

/** A lifecycle event the start reports, before the session's identity is stamped on it. */
export type ClaudeStartupReport =
  | ({
      type: 'started' | 'options-reported'
    } & StructuredAgentSessionStartedOptions)
  | Pick<StructuredAgentSessionOptionsSkippedEvent, 'type' | 'options'>

/** What the initialize answer proved: enough to start. */
export type ClaudeInitializeFacts = {
  init: ClaudeInitObservation | null
  initProof: ClaudeInitProof
  initialization: unknown
  resumesTranscript: boolean
  requestTimeoutMs: number | undefined
}

/** The initialize facts and the optional settings read that followed them. */
export type ClaudeStartupFacts = ClaudeInitializeFacts & {
  settings: unknown
  prepared: ReturnType<typeof prepareClaudeStructuredSessionAcquisitionOptions>
}

/** Settles on the CLI's initialize answer, or on its exit or a refused proof. */
export async function readClaudeStartupFacts(input: {
  connection: ClaudeStreamJsonConnection
  initProof: ClaudeInitProof
  sessionId: string
  providerSessionId: string
  startup: Pick<ClaudeSessionStartup, 'answered'>
  resumesTranscript: boolean
  account?: AgentSessionAccountKind
  requestTimeoutMs: number | undefined
  emit: (event: ClaudeStructuredSessionEvent) => void
}): Promise<ClaudeInitializeFacts> {
  // The CLI's first answer has no request deadline of its own; the reads after it do.
  const initialization = await Promise.race([
    input.connection.initializationResult().then((result) => {
      input.startup.answered = true
      const authError = claudeInitializationAuthError(result, input.account)
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
  return {
    init: input.initProof.seen(),
    initProof: input.initProof,
    initialization,
    resumesTranscript: input.resumesTranscript,
    requestTimeoutMs: input.requestTimeoutMs
  }
}

function applyClaudeInitializeFacts(session: ClaudeSession, facts: ClaudeInitializeFacts): void {
  const { init, initialization } = facts
  // A turn's own init frame may already have reported the running model.
  if (init?.model && session.reportedOptions.model === undefined) {
    session.reportedOptions.model = init.model
    session.reportedModelMutation = session.optionMutationSequence
  }
  const fastModeFacts = readClaudeFastModeFacts(initialization)
  session.fastModeState ??= fastModeFacts.state
  session.fastModeDisabledReason ??= fastModeFacts.disabledReason
  session.capabilities = readClaudeCapabilities(session.capabilities, initialization, init?.message)
  // A catalog frame that streamed in after publish is newer than the initialize answer.
  if (session.commands.commands === undefined) {
    session.commands = new ClaudeSlashCommandCatalog(init?.message, initialization)
  }
  session.events?.publish()
}

/** Settings read after `started`. Values a write made since the read began own are left alone. */
function applyClaudeSettingsFacts(
  session: ClaudeSession,
  facts: ClaudeStartupFacts,
  writtenSinceRead: boolean
): void {
  const { settings, prepared } = facts
  const effort = readClaudeSettingsEffort(settings)
  const published = claudeStructuredSessionPublicationOptions(prepared)
  observeClaudeSettingsApplied(session, settings)
  if (published.fastModePerSessionOptIn !== null) {
    session.fastModePerSessionOptIn = published.fastModePerSessionOptIn
  }
  if (writtenSinceRead) {
    session.events?.publish()
    return
  }
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
  session.events?.publish()
}

/** What the start persists as the session's options, and the account listing it read for the
 *  host's catalog. The applied effort is display-only: saved, it would pin an effort nobody chose
 *  on every reopen, past a later settings change. */
function claudeStartedReportedOptions(
  session: ClaudeSession,
  catalog: unknown[],
  readMutationSequence = session.optionMutationSequence
): Pick<StructuredAgentSessionStartedOptions, 'reportedOptions' | 'catalogListing'> {
  const { current, catalogListing } = claudeStructuredSessionOptionsFrom(
    session,
    catalog,
    readMutationSequence
  )
  const listing = catalogListing ? { catalogListing } : {}
  if (session.options.has('effort') || session.reportedOptions.effort !== undefined) {
    return { reportedOptions: current, ...listing }
  }
  const { effort: _displayOnly, ...persisted } = current
  return { reportedOptions: persisted, ...listing }
}

/** Applies the initialize answer and reports `started`, so the host hands the child what it holds;
 *  then reads the optional settings and reports what they add. A failure before `started` faults
 *  the session so the user sees why it never started; the settings read can fail nothing. */
export async function settleClaudeSessionStartup(input: {
  session: ClaudeSession
  facts: Promise<ClaudeInitializeFacts>
  /** Never rejects: an unreadable settings answer reads as null. */
  readSettings: () => Promise<unknown>
  isCurrent: () => boolean
  fault: (error: Error) => void
  diagnose: (diagnostic: ClaudeAuthDiagnostic) => void
  /** The host's option revision now, stamped on each report as its read begins. */
  optionRevision: () => number
  /** `started` once startup has proven, with what the child now reports, snapshotted from memory;
   *  then what the settings add, and any saved option the child showed it cannot run. */
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
  let initialized: ClaudeInitializeFacts
  try {
    initialized = await input.facts
    if (superseded()) {
      return
    }
    // From here no read of the proof is pending, so a frame naming another session ends it.
    initialized.initProof.onRefusal = (error) => {
      failClaudeStartup(session, error)
      if (input.isCurrent()) {
        input.fault(error)
      }
    }
    applyClaudeInitializeFacts(session, initialized)
    input.report({
      type: 'started',
      // `list_models` is answered from this same initialize result, so nothing is re-read. A
      // saved Fast the launch left out is decided once settings are read, so this read settles
      // none of it (an older sequence never rewrites an option).
      ...claudeStartedReportedOptions(
        session,
        readClaudeModels(initialized.initialization),
        session.fastModeAtStart ? session.optionMutationSequence - 1 : undefined
      ),
      restoreSkippedOptions: [...session.restoreSkippedOptions],
      ...claudeRetiredOptions(session),
      optionRevision: input.optionRevision()
    })
    if (session.startup.state === 'pending') {
      session.startup.state = 'proven'
    }
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught))
    // A close or exit that already ended startup owns how the session ends.
    const endedElsewhere = session.startup.state !== 'pending'
    failClaudeStartup(session, error)
    if (!endedElsewhere && input.isCurrent()) {
      input.fault(error)
    }
    return
  }
  await settleClaudeStartupSettings(input, initialized)
}

async function settleClaudeStartupSettings(
  input: Parameters<typeof settleClaudeSessionStartup>[0],
  initialized: ClaudeInitializeFacts
): Promise<void> {
  const { session } = input
  const sequence = session.optionMutationSequence
  // Only a pick moves it, so this stamp holds however late the host takes `started`.
  const optionRevision = input.optionRevision()
  const settings = await input.readSettings()
  if (!input.isCurrent()) {
    return
  }
  let init: ClaudeInitObservation | null
  try {
    // Read again: a frame naming the session may have come since; a refusal is already ending it.
    init = initialized.initProof.seen()
  } catch {
    return
  }
  const facts: ClaudeStartupFacts = {
    ...initialized,
    init,
    settings,
    prepared: prepareClaudeStructuredSessionAcquisitionOptions({
      settings,
      initialization: initialized.initialization
    })
  }
  input.diagnose(claudeAuthDiagnostic(facts.initialization, facts.init, settings))
  const writtenSinceRead = sequence !== session.optionMutationSequence
  applyClaudeSettingsFacts(session, facts, writtenSinceRead)
  const startFastMode = writtenSinceRead ? null : admitClaudeStartFastMode(session, facts)
  input.report({
    type: 'options-reported',
    // `started` already carried this listing to the host.
    reportedOptions: claudeStartedReportedOptions(session, readClaudeModels(facts.initialization))
      .reportedOptions,
    // The one report of what the config resolved: the readback just applied it.
    ...claudeResolvedCatalogListing(session, readClaudeModels(facts.initialization)),
    restoreSkippedOptions: [...session.restoreSkippedOptions],
    ...claudeRetiredOptions(session),
    optionRevision
  })
  if (startFastMode !== null) {
    void applyClaudeStartFastMode(session, facts, startFastMode, (event) => {
      if (input.isCurrent()) {
        input.report(event)
      }
    })
  }
}
