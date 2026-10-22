import type { AgentSessionFastModeState } from '../../shared/agent-session-wire'
import {
  currentModelIsDefaulted,
  listedModels,
  record,
  seedModels,
  text
} from './claude-structured-model-catalog'
import type { ClaudeSession } from './claude-structured-session-state'
import { structuredAgentSessionOptionModels } from '../native-chat/agent-session-wire/structured-agent-session-option-models'
import {
  claudeFastModeSupport,
  wireClaudeModels,
  type WireClaudeModel
} from './claude-structured-catalog-listing'
import type { StructuredAgentSessionLiveOptions } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'

/**
 * The session's current effort, which only `get_settings` reports: the
 * `system/init` frame carries `model` but has never carried an effort of any
 * kind. Null when the provider stops reporting it, so the pill goes empty
 * rather than showing an effort nothing measured.
 */
export function readClaudeSettingsEffort(settings: unknown): string | null {
  return text(record(record(settings)?.effective)?.effortLevel)
}

/** `applied` is the CLI's own resolution of env over settings over its listed default; a null
 *  effort means none is sent. Null when the CLI predates the block. */
export function readClaudeSettingsApplied(
  settings: unknown
): NonNullable<ClaudeSession['appliedOptions']> | null {
  const applied = record(record(settings)?.applied)
  if (!applied) {
    return null
  }
  const model = text(applied.model)
  const effort = text(applied.effort)
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

export function observeClaudeSettingsApplied(session: ClaudeSession, settings: unknown): void {
  const applied = readClaudeSettingsApplied(settings)
  if (applied) {
    session.appliedOptions = applied
  } else {
    delete session.appliedOptions
  }
}

export function readClaudeSettingsFastMode(settings: unknown): boolean | null {
  const value = record(record(settings)?.effective)?.fastMode
  return typeof value === 'boolean' ? value : null
}

export function readClaudeSettingsFastModePerSessionOptIn(settings: unknown): boolean | null {
  const value = record(record(settings)?.effective)?.fastModePerSessionOptIn
  return typeof value === 'boolean' ? value : null
}

const FAST_MODE_STATES: readonly AgentSessionFastModeState[] = ['off', 'cooldown', 'on']

export function readClaudeFastModeFacts(value: unknown): {
  state?: AgentSessionFastModeState
  disabledReason?: string
  disabledReasonReported: boolean
} {
  const row = record(value)
  const state = text(row?.fast_mode_state)
  // Narrowed by lookup, so the wire string reaches the session only as a known state.
  const matched = FAST_MODE_STATES.find((entry) => entry === state)
  const reportedDisabledReason = text(row?.fast_mode_disabled_reason)
  return {
    ...(matched ? { state: matched } : {}),
    ...(reportedDisabledReason ? { disabledReason: reportedDisabledReason } : {}),
    disabledReasonReported: Object.hasOwn(row ?? {}, 'fast_mode_disabled_reason')
  }
}

export function observeClaudeFastModeFacts(session: ClaudeSession, value: unknown): void {
  const facts = readClaudeFastModeFacts(value)
  if (facts.state) {
    session.fastModeState = facts.state
    session.fastModeReportedMutation = session.optionMutationSequence
  }
  if (facts.disabledReason) {
    session.fastModeDisabledReason = facts.disabledReason
  } else if (facts.state || facts.disabledReasonReported) {
    // The child omits the reason entirely when nothing blocks Fast — it never sends a
    // null — so a frame that reports state without one is the only all-clear there is.
    // Requiring the key back would latch the first reason for the session's life and
    // retire the control for good: a model switch away and back never restores it.
    delete session.fastModeDisabledReason
  }
}

/**
 * The model the session is running. A report the CLI made after the last write
 * outranks the write: it names the model the session ran. An older one does not
 * — a model set between turns has no report yet, and deferring to the previous
 * turn's would flip the pill back. With neither, it is the model Claude says it
 * will apply, never the listing's default, which env or settings may override.
 *
 * Sole resolver of that question: every surface that acts on "the current model"
 * — the pill, the effort guard, the rejection it names — reads it here, so two
 * of them cannot answer it differently and offer an effort a third then refuses.
 */
export function readClaudeCurrentModel(session: ClaudeSession): {
  id: string | undefined
  confirmed: boolean
} {
  const confirmed =
    session.reportedModelMutation === session.optionMutationSequence &&
    session.reportedOptions.model !== undefined
  return {
    id: confirmed
      ? session.reportedOptions.model
      : (session.options.get('model') ??
        session.reportedOptions.model ??
        session.appliedOptions?.model),
    confirmed
  }
}

function decodedFastMode(session: ClaudeSession): boolean | undefined {
  const encoded = session.options.get('fastMode')
  if (encoded === undefined) {
    return undefined
  }
  const decoded = decodeStructuredAgentSessionOptionValue('fastMode', encoded)
  return typeof decoded === 'boolean' ? decoded : undefined
}

/** The built-in models a running child lists when the CLI gives it none; a chat at rest with no
 *  catalog lists the same. */
export function claudeFallbackModelOptions(): WireClaudeModel[] {
  return wireClaudeModels(seedModels())
}

export async function readClaudeStructuredSessionOptions(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<StructuredAgentSessionLiveOptions> {
  const readMutationSequence = session.optionMutationSequence
  const settings = await session.connection.getSettings({ timeoutMs }).catch(() => null)
  observeClaudeSettingsReadback(session, settings, readMutationSequence)
  return claudeStructuredSessionOptionsFrom(session, null)
}

function observeClaudeSettingsReadback(
  session: ClaudeSession,
  settings: unknown,
  readMutationSequence: number
): void {
  if (settings !== null && readMutationSequence === session.optionMutationSequence) {
    const effort = readClaudeSettingsEffort(settings)
    const fastMode = readClaudeSettingsFastMode(settings)
    const perSessionOptIn = readClaudeSettingsFastModePerSessionOptIn(settings)
    observeClaudeSettingsApplied(session, settings)
    if (effort) {
      session.reportedOptions.effort = effort
    }
    if (fastMode !== null) {
      session.reportedOptions.fastMode = fastMode
      if (!fastMode) {
        delete session.fastModeReportedMutation
      }
      if (decodedFastMode(session) !== undefined) {
        session.options.set('fastMode', String(fastMode))
      }
      session.confirmedOptions.add('fastMode')
    }
    if (perSessionOptIn !== null) {
      session.fastModePerSessionOptIn = perSessionOptIn
    }
  }
}

/** The options already held in memory, over `catalog`; asks the CLI nothing. The SDK answers
 *  `list_models` from initialize, so open passes that result without another round trip. */
export function claudeStructuredSessionOptionsFrom(
  session: ClaudeSession,
  catalog: unknown[] | null
): StructuredAgentSessionLiveOptions {
  const discovered = listedModels(catalog ? { models: catalog } : null)
  const listed = discovered.length > 0 ? discovered : seedModels()
  const current = readClaudeCurrentModel(session)
  const model = current.id === 'default' ? undefined : current.id
  const models = structuredAgentSessionOptionModels(listed, model, (row) => ({
    ...row,
    resolvedModel: null
  }))
  const effort =
    session.options.get('effort') ??
    session.reportedOptions.effort ??
    session.appliedOptions?.effort
  const desiredFastMode = decodedFastMode(session)
  // The child answers Fast two ways and need not answer both: the settings readback
  // carries the boolean, and the session frames carry a routing state. A fresh
  // session reports the state while the boolean is still absent, so without this
  // fallback the picker asks the user to re-answer what the provider just reported.
  // `cooldown` throttles routing, it does not clear the pick, so it reads as on —
  // reading it as off would flip a control nobody touched.
  const fastMode =
    desiredFastMode ??
    session.reportedOptions.fastMode ??
    (session.fastModeState === undefined ? undefined : session.fastModeState !== 'off')
  const support = claudeFastModeSupport([], session.fastModeDisabledReason)
  const confirmed = [
    ...(current.confirmed ? ['model'] : []),
    ...(effort && session.confirmedOptions.has('effort') ? ['effort'] : []),
    ...(fastMode !== undefined &&
    (session.confirmedOptions.has('fastMode') || !session.options.has('fastMode'))
      ? ['fastMode']
      : [])
  ]
  return {
    models: wireClaudeModels(models),
    ...(support ? { fastModeSupport: support } : {}),
    current: {
      model,
      ...(effort ? { effort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      ...(session.fastModeState ? { fastModeState: session.fastModeState } : {}),
      ...(confirmed.length > 0 ? { confirmed } : {}),
      ...(currentModelIsDefaulted(current.id) ? { defaulted: ['model'] as const } : {})
    }
  }
}
