// Initialize gates host open after process publication; settings enrichment runs independently.

import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/structured-agent-session-provider-open-contract'
import { withProviderRequestTimeout } from '../provider-process/provider-request-timeout'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import { ClaudeSlashCommandCatalog } from './claude-slash-command-catalog'
import {
  claudeAuthDiagnostic,
  claudeInitializationAuthError,
  readClaudeCapabilities,
  readClaudeReportedPermissionMode,
  readClaudeModels,
  type ClaudeInitObservation,
  type ClaudeInitProof
} from './claude-structured-init-proof'
import {
  claudeStructuredSessionPublicationOptions,
  prepareClaudeStructuredSessionAcquisitionOptions
} from './claude-structured-session-acquisition-options'
import {
  claudeStructuredSessionOptionsFrom,
  observeClaudeSettingsApplied,
  readClaudeSettingsApplied,
  readClaudeFastModeFacts,
  readClaudeSettingsEffort
} from './claude-structured-session-options'
import { claudeExecutionObservations } from './claude-structured-execution-observations'
import type {
  ClaudeAuthDiagnostic,
  ClaudeSession,
  ClaudeStructuredSessionEvent
} from './claude-structured-session-state'

export type ClaudeOpenFacts = Pick<StructuredAgentSessionProviderOpenResult, 'reportedOptions'>

export type ClaudeStartupReport = {
  type: 'options-reported'
} & ClaudeOpenFacts

export type ClaudeInitializeFacts = {
  init: ClaudeInitObservation | null
  initProof: ClaudeInitProof
  initialization: unknown
  resumesTranscript: boolean
  requestTimeoutMs: number | undefined
}

export type ClaudeStartupFacts = ClaudeInitializeFacts & {
  settings: unknown
  prepared: ReturnType<typeof prepareClaudeStructuredSessionAcquisitionOptions>
}

export const CLAUDE_INITIALIZE_TIMEOUT_MS = 60_000

export async function readClaudeStartupFacts(input: {
  connection: ClaudeStreamJsonConnection
  initProof: ClaudeInitProof
  sessionId: string
  providerSessionId: string
  resumesTranscript: boolean
  account?: AgentSessionAccountKind
  requestTimeoutMs: number | undefined
  emit: (event: ClaudeStructuredSessionEvent) => void
}): Promise<ClaudeInitializeFacts> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const initialization = await Promise.race([
    input.connection
      .initializationResult()
      .catch((error: unknown) => {
        // The SDK may replace the child's own exit diagnostic with a generic closed-query error.
        input.initProof.seen()
        throw error
      })
      .then((result) => {
        const authError = claudeInitializationAuthError(result, input.account)
        if (authError) {
          throw authError
        }
        return result
      }),
    input.initProof.promise.then(() => new Promise<never>(() => {})),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            withProviderRequestTimeout(
              new Error(
                `claude did not answer initialize within ${CLAUDE_INITIALIZE_TIMEOUT_MS}ms`
              ),
              { method: 'initialize', timeoutMs: CLAUDE_INITIALIZE_TIMEOUT_MS }
            )
          ),
        CLAUDE_INITIALIZE_TIMEOUT_MS
      )
      timer.unref?.()
    })
  ]).finally(() => clearTimeout(timer))
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
  const permission = facts.init ? readClaudeReportedPermissionMode(facts.init.message) : undefined
  if (permission !== undefined && session.reportedOptions.reportedPermissionMode === undefined) {
    session.reportedOptions.reportedPermissionMode = permission
  }
  const { init, initialization } = facts
  // Preserve a running model already reported by a turn's init frame.
  if (init?.model && session.reportedOptions.model === undefined) {
    session.reportedOptions.model = init.model
    session.reportedModelMutation = session.optionMutationSequence
  }
  const fastModeFacts = readClaudeFastModeFacts(initialization)
  if (session.fastModeState === undefined && fastModeFacts.state) {
    session.fastModeState = fastModeFacts.state
    session.fastModeReportedMutation = 0
  }
  session.fastModeDisabledReason ??= fastModeFacts.disabledReason
  session.capabilities = readClaudeCapabilities(session.capabilities, initialization, init?.message)
  // Streamed catalog updates take precedence over initialize.
  if (session.commands.commands === undefined) {
    session.commands = new ClaudeSlashCommandCatalog(init?.message, initialization)
  }
  session.events?.publish()
}

/** A later settings read cannot overwrite a newer option write. */
function applyClaudeSettingsFacts(
  session: ClaudeSession,
  facts: ClaudeStartupFacts,
  writtenSinceRead: boolean
): void {
  const { settings, prepared } = facts
  const effort = readClaudeSettingsEffort(settings)
  const published = claudeStructuredSessionPublicationOptions(prepared)
  if (!writtenSinceRead) {
    const applied = readClaudeSettingsApplied(settings)
    session.configuredDefaults = {
      ...(!session.options.has('model') && applied?.model ? { model: applied.model } : {}),
      ...(!session.options.has('effort') && applied?.effort ? { effort: applied.effort } : {})
    }
  }
  if (published.fastModePerSessionOptIn !== null) {
    session.fastModePerSessionOptIn = published.fastModePerSessionOptIn
  }
  if (writtenSinceRead) {
    session.events?.publish()
    return
  }
  observeClaudeSettingsApplied(session, settings)
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
    if (!published.fastMode) {
      delete session.fastModeReportedMutation
    }
    if (agrees('fastMode', String(published.fastMode))) {
      session.confirmedOptions.add('fastMode')
    }
  }
  session.events?.publish()
}

/** Do not persist display-only effort: that would pin an unchosen default across later starts. */
function claudeStartedReportedOptions(
  session: ClaudeSession,
  catalog: unknown[]
): Pick<ClaudeOpenFacts, 'reportedOptions'> {
  const { current } = claudeStructuredSessionOptionsFrom(session, catalog)
  const { model: _projected, ...rest } = current
  const model = claudeExecutionObservations(session).model
  const observed = { ...rest, ...(model ? { model } : {}) }
  if (session.options.has('effort') || session.reportedOptions.effort !== undefined) {
    return { reportedOptions: observed }
  }
  const { effort: _displayOnly, ...persisted } = observed
  return { reportedOptions: persisted }
}

export async function openClaudeSession(input: {
  session: ClaudeSession
  facts: Promise<ClaudeInitializeFacts>
  readSettings: () => Promise<unknown>
  isCurrent: () => boolean
  diagnose: (diagnostic: ClaudeAuthDiagnostic) => void
  onLateRefusal: (error: Error) => void
  report: (event: ClaudeStartupReport) => void
}): Promise<ClaudeOpenFacts> {
  const { session } = input
  const initialized = await input.facts
  if (!input.isCurrent()) {
    throw new Error('claude session closed before startup completed')
  }
  initialized.initProof.onRefusal = (error) => {
    if (input.isCurrent()) {
      input.onLateRefusal(error)
    }
  }
  applyClaudeInitializeFacts(session, initialized)
  const result: ClaudeOpenFacts = {
    ...claudeStartedReportedOptions(session, readClaudeModels(initialized.initialization))
  }
  void settleClaudeStartupSettings(input, initialized)
  return result
}

async function settleClaudeStartupSettings(
  input: Parameters<typeof openClaudeSession>[0],
  initialized: ClaudeInitializeFacts
): Promise<void> {
  const { session } = input
  const sequence = session.optionMutationSequence
  const settings = await input.readSettings()
  if (!input.isCurrent()) {
    return
  }
  let init: ClaudeInitObservation | null
  try {
    // Include proof received during the settings read; refusal already ends the session.
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
  input.report({
    type: 'options-reported',
    reportedOptions: claudeStartedReportedOptions(session, readClaudeModels(facts.initialization))
      .reportedOptions
  })
}
