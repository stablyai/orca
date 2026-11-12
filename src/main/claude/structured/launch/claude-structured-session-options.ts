import type { AgentSessionFastModeState } from '../../../../shared/agent-session/agent-session-wire'
import {
  currentModelIsDefaulted,
  listedModels,
  record,
  seedModels,
  text
} from './claude-structured-model-catalog'
import type { ClaudeSession } from '../claude-structured-session-state'
import {
  structuredAgentSessionOptionModels,
  type StructuredAgentSessionLiveOptions
} from '../../../native-chat/agent-session-wire/options/structured-agent-session-option-models'
import { wireClaudeModels, type WireClaudeModel } from './claude-structured-catalog-listing'
import { decodeStructuredAgentSessionOptionValue } from '../../../../shared/agent-session/options/structured-agent-session-option-codec'

function claudeSettingsEffortFacts(settings: unknown): {
  raw: string | null | undefined
  observed: string | null | undefined
} {
  const root = record(settings)
  const applied = record(root?.applied)
  const raw = applied?.effort === null ? null : (text(applied?.effort) ?? undefined)
  const legacy =
    root !== null &&
    (!Object.hasOwn(root, 'applied') || (applied !== null && !Object.hasOwn(applied, 'effort')))
  return { raw, observed: legacy ? (text(record(root?.effective)?.effortLevel) ?? undefined) : raw }
}

/** Applied effort includes native overrides; only older CLIs need the settings fallback. */
export function readClaudeSettingsEffort(settings: unknown): string | null | undefined {
  return claudeSettingsEffortFacts(settings).observed
}

export function observeClaudeSettingsEffort(
  session: ClaudeSession,
  settings: unknown
): string | null | undefined {
  const effort = readClaudeSettingsEffort(settings)
  if (effort === null) {
    delete session.reportedOptions.effort
  } else if (effort !== undefined) {
    session.reportedOptions.effort = effort
  }
  const held = session.options.get('effort')
  // Native defaults stay observations; only a matching held input is corroborated.
  if (held === undefined || (effort !== undefined && effort !== held)) {
    session.confirmedOptions.delete('effort')
  } else if (effort !== undefined) {
    session.confirmedOptions.add('effort')
  }
  return effort
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
  const effort = claudeSettingsEffortFacts(settings).raw
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(typeof applied.ultracode === 'boolean' ? { ultracode: applied.ultracode } : {})
  }
}

/** Like effort, only a held pick that Claude's applied Ultracode matches is corroborated. */
export function observeClaudeSettingsUltracode(session: ClaudeSession, settings: unknown): void {
  const reported = record(record(settings)?.applied)?.ultracode
  const applied = typeof reported === 'boolean' ? String(reported) : undefined
  const held = session.options.get('ultracode')
  if (held === undefined || (applied !== undefined && applied !== held)) {
    session.confirmedOptions.delete('ultracode')
  } else if (applied !== undefined) {
    session.confirmedOptions.add('ultracode')
  }
}

export function observeClaudeSettingsApplied(session: ClaudeSession, settings: unknown): void {
  const applied = readClaudeSettingsApplied(settings)
  if (applied) {
    session.appliedOptions = applied
    if (applied.ultracode !== undefined) {
      session.reportedOptions.ultracode = applied.ultracode
      if (session.ultracodeControlIntent === applied.ultracode) {
        delete session.ultracodeControlIntent
      }
    }
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
} {
  const state = text(record(value)?.fast_mode_state)
  const matched = FAST_MODE_STATES.find((entry) => entry === state)
  return matched ? { state: matched } : {}
}

export function observeClaudeFastModeFacts(session: ClaudeSession, value: unknown): void {
  const facts = readClaudeFastModeFacts(value)
  if (facts.state) {
    session.fastModeState = facts.state
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

function decodedSwitch(session: ClaudeSession, key: 'fastMode' | 'ultracode'): boolean | undefined {
  const encoded = session.options.get(key)
  if (encoded === undefined) {
    return undefined
  }
  const decoded = decodeStructuredAgentSessionOptionValue(key, encoded)
  return typeof decoded === 'boolean' ? decoded : undefined
}

export function claudeFallbackModelOptions(): WireClaudeModel[] {
  return wireClaudeModels(seedModels())
}

export async function readClaudeStructuredSessionOptions(
  session: ClaudeSession,
  _timeoutMs?: number
): Promise<StructuredAgentSessionLiveOptions> {
  return claudeStructuredSessionOptionsFrom(session, null)
}

/** Native turn completion owns optional settings observations, independently of user actions. */
export async function refreshClaudeStructuredSessionOptions(
  session: ClaudeSession,
  timeoutMs: number | undefined,
  current: () => boolean,
  report: (options: StructuredAgentSessionLiveOptions) => void
): Promise<void> {
  const sequence = session.optionMutationSequence
  const token = { pending: session.settingsObservation?.pending ?? false }
  session.settingsObservation = token
  const connection = session.connection
  const settings = await connection.getSettings({ timeoutMs }).catch(() => null)
  if (
    !current() ||
    connection.closed ||
    token.pending ||
    session.settingsObservation !== token ||
    sequence !== session.optionMutationSequence
  ) {
    return
  }
  observeClaudeSettingsReadback(session, settings, sequence)
  report(claudeStructuredSessionOptionsFrom(session, null))
}

function observeClaudeSettingsReadback(
  session: ClaudeSession,
  settings: unknown,
  readMutationSequence: number
): void {
  if (settings !== null && readMutationSequence === session.optionMutationSequence) {
    observeClaudeSettingsEffort(session, settings)
    observeClaudeSettingsUltracode(session, settings)
    const fastMode = readClaudeSettingsFastMode(settings)
    const perSessionOptIn = readClaudeSettingsFastModePerSessionOptIn(settings)
    observeClaudeSettingsApplied(session, settings)
    if (fastMode !== null) {
      session.reportedOptions.fastMode = fastMode
      if (decodedSwitch(session, 'fastMode') !== undefined) {
        session.options.set('fastMode', String(fastMode))
      }
      session.confirmedOptions.add('fastMode')
    }
    if (perSessionOptIn !== null) {
      session.fastModePerSessionOptIn = perSessionOptIn
    }
  }
}

/** Effort and Fast change through a control this CLI never answers. */
const CLAUDE_CLI_UPDATE_REQUIRED = { supported: false, reason: 'cli-update-required' }

/** Reuse the initialize catalog and held options without another CLI request. */
export function claudeStructuredSessionOptionsFrom(
  session: ClaudeSession,
  catalog: unknown[] | null
): StructuredAgentSessionLiveOptions {
  const discovered = listedModels(catalog ? { models: catalog } : null)
  const listed = discovered.length > 0 ? discovered : seedModels()
  const current = readClaudeCurrentModel(session)
  const reportsPick = !session.modelPickAwaitingTurn
  const model = current.id === 'default' ? undefined : current.id
  const models = structuredAgentSessionOptionModels(listed, model, (row) => ({
    ...row,
    resolvedModel: null
  }))
  const changesLive = session.flagSettingsControl !== 'unsupported'
  const effort =
    session.options.get('effort') ??
    session.reportedOptions.effort ??
    session.appliedOptions?.effort
  const ultracode =
    decodedSwitch(session, 'ultracode') ??
    session.ultracodeControlIntent ??
    (session.legacyUltracodePreset ? true : undefined) ??
    session.reportedOptions.ultracode ??
    session.appliedOptions?.ultracode
  const desiredFastMode = decodedSwitch(session, 'fastMode')
  // Frames can report Fast before settings do; cooldown throttles routing but preserves the preference.
  const fastMode =
    desiredFastMode ??
    session.reportedOptions.fastMode ??
    (session.fastModeState === undefined ? undefined : session.fastModeState !== 'off')
  const confirmed = [
    ...(current.confirmed && reportsPick ? ['model'] : []),
    ...(effort && session.confirmedOptions.has('effort') ? ['effort'] : []),
    ...(ultracode !== undefined &&
    (session.confirmedOptions.has('ultracode') ||
      (!session.options.has('ultracode') && ultracode === session.appliedOptions?.ultracode))
      ? ['ultracode']
      : []),
    ...(fastMode !== undefined &&
    (session.confirmedOptions.has('fastMode') || !session.options.has('fastMode'))
      ? ['fastMode']
      : [])
  ]
  return {
    models: wireClaudeModels(models),
    ...(changesLive ? {} : { fastModeSupport: CLAUDE_CLI_UPDATE_REQUIRED }),
    ...(changesLive ? {} : { effortFixed: true as const }),
    current: {
      model,
      reportedModel: reportsPick ? session.reportedOptions.reportedModel : undefined,
      reportedPermissionMode: session.reportedOptions.reportedPermissionMode,
      ...(effort ? { effort } : {}),
      ...(ultracode !== undefined ? { ultracode } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      ...(session.fastModeState ? { fastModeState: session.fastModeState } : {}),
      ...(confirmed.length > 0 ? { confirmed } : {}),
      ...(currentModelIsDefaulted(current.id) ? { defaulted: ['model'] as const } : {})
    }
  }
}
