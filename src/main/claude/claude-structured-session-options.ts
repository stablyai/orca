import type { AgentSessionFastModeState } from '../../shared/agent-session-wire'
import {
  currentModelIsDefaulted,
  listedModels,
  record,
  seedModels,
  text
} from './claude-structured-model-catalog'
import type { ClaudeSession } from './structured/claude-structured-session-state'
import { structuredAgentSessionOptionModels } from '../native-chat/agent-session-wire/structured-agent-session-option-models'
import {
  claudeFastModeSupport,
  wireClaudeModels,
  type WireClaudeModel
} from './claude-structured-catalog-listing'
import type { StructuredAgentSessionLiveOptions } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'

/** Effort comes from settings; system/init omits it. */
export function readClaudeSettingsEffort(settings: unknown): string | null {
  return text(record(record(settings)?.effective)?.effortLevel)
}

/** CLI resolution of env, settings and defaults; null effort sends none, and older CLIs omit the block. */
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
    // A state frame without a reason clears the block; the child omits the key instead of sending null.
    delete session.fastModeDisabledReason
  }
}

/** Prefer fresh reports, then held options, older reports and applied values; never catalog defaults. */
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

/** Reuse the initialize catalog and held options without another CLI request. */
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
  // Frames can report Fast before settings do; cooldown throttles routing but preserves the preference.
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
      reportedPermissionMode: session.reportedOptions.reportedPermissionMode,
      ...(effort ? { effort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      ...(session.fastModeState ? { fastModeState: session.fastModeState } : {}),
      ...(confirmed.length > 0 ? { confirmed } : {}),
      ...(currentModelIsDefaulted(current.id) ? { defaulted: ['model'] as const } : {})
    }
  }
}
