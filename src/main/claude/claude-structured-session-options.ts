import type {
  AgentSessionFastModeState,
  AgentSessionFastModeSupport,
  AgentSessionOptionsResult
} from '../../shared/agent-session-wire'
import {
  currentModelId,
  listedModels,
  matchListedModel,
  record,
  seedModels,
  text,
  type ListedModel
} from './claude-structured-model-catalog'
import type { ClaudeSession } from './claude-structured-session-state'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import {
  readStructuredAgentSessionPermissionMode,
  type StructuredAgentSessionPermissionMode
} from '../../shared/structured-agent-session-permission-mode'
import { claudePublishedPermissionMode } from './claude-structured-permission-mode-projection'

/**
 * The session's current effort, which only `get_settings` reports: the
 * `system/init` frame carries `model` but has never carried an effort of any
 * kind. Null when the provider stops reporting it, so the pill goes empty
 * rather than showing an effort nothing measured.
 */
export function readClaudeSettingsEffort(settings: unknown): string | null {
  return text(record(record(settings)?.effective)?.effortLevel)
}

export function readClaudeSettingsFastMode(settings: unknown): boolean | null {
  const value = record(record(settings)?.effective)?.fastMode
  return typeof value === 'boolean' ? value : null
}

export function readClaudeSettingsFastModePerSessionOptIn(settings: unknown): boolean | null {
  const value = record(record(settings)?.effective)?.fastModePerSessionOptIn
  return typeof value === 'boolean' ? value : null
}

export function readClaudeSettingsPermissionMode(
  settings: unknown
): StructuredAgentSessionPermissionMode | null {
  const settingsRecord = record(settings)
  return (
    readStructuredAgentSessionPermissionMode(record(settingsRecord?.applied)?.permissionMode) ??
    readStructuredAgentSessionPermissionMode(record(settingsRecord?.effective)?.permissionMode)
  )
}

export function observeClaudeUserPermissionMode(session: ClaudeSession, value: unknown): void {
  if (
    !session.options.has('permissionMode') &&
    session.reportedPermissionModeMutation === session.permissionModeMutationSequence
  ) {
    return
  }
  if (
    session.confirmedOptions.has('permissionMode') &&
    session.reportedPermissionModeMutation === session.permissionModeMutationSequence
  ) {
    return
  }
  const permissionMode = readStructuredAgentSessionPermissionMode(record(value)?.permissionMode)
  if (!permissionMode) {
    return
  }
  const previousPermissionMode = session.reportedOptions.permissionMode
  const wasConfirmed = session.confirmedOptions.has('permissionMode')
  session.reportedOptions.permissionMode = permissionMode
  session.reportedPermissionModeMutation = session.permissionModeMutationSequence
  const desiredPermissionMode = session.options.get('permissionMode') ?? session.basePermissionMode
  if (desiredPermissionMode === permissionMode) {
    session.confirmedOptions.add('permissionMode')
  } else {
    session.confirmedOptions.delete('permissionMode')
  }
  if (
    previousPermissionMode !== permissionMode ||
    wasConfirmed !== session.confirmedOptions.has('permissionMode')
  ) {
    session.events?.optionsChanged?.()
  }
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
  observeClaudeUserPermissionMode(session, value)
  const facts = readClaudeFastModeFacts(value)
  if (facts.state) {
    session.fastModeState = facts.state
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
 * turn's would flip the pill back.
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
      : (session.options.get('model') ?? session.reportedOptions.model),
    confirmed
  }
}

/**
 * The effort levels the session's current model advertises, with the catalog id
 * that matched so a refusal names the model the pill shows. Levels are null when
 * nothing identified the model: `apply_flag_settings` accepts and stores any
 * level for a model with no effort control, so the catalog is the only evidence
 * of a refusal — and an absent or unlisted one is not evidence, or a live CLI
 * that predates `list_models` would have every effort refused under it.
 */
/** One catalog read serves a whole option write. The admit check, the effort guard
 *  and the Fast guard all ask about the same list; each taking its own read made a
 *  single model write pay for two `list_models` round trips and let two guards answer
 *  from two different catalogs. An unreadable catalog is an empty list, which
 *  identifies no model and so refuses nothing. */
export async function readClaudeListedModels(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<ListedModel[]> {
  const catalog = await session.connection.supportedModels({ timeoutMs }).catch(() => null)
  return catalog ? listedModels({ models: catalog }) : []
}

export function claudeModelEffortLevels(
  session: ClaudeSession,
  models: readonly ListedModel[]
): { modelId: string | undefined; levels: ReadonlySet<string> | null } {
  const modelId = readClaudeCurrentModel(session).id
  const matched = modelId
    ? models.find((model) => model.id === modelId || model.resolvedModel === modelId)
    : undefined
  return {
    modelId: matched?.id ?? modelId,
    levels: matched ? new Set(matched.efforts.map((choice) => choice.value)) : null
  }
}

export function claudeModelFastModeSupport(
  session: ClaudeSession,
  models: readonly ListedModel[],
  requestedModel?: string
): { modelId: string | undefined; supported: boolean | null } {
  const reportedModelId = requestedModel ?? readClaudeCurrentModel(session).id
  const modelId = reportedModelId ?? models.find((model) => model.isDefault)?.id
  const matched = modelId ? matchListedModel(models, modelId) : undefined
  return {
    modelId: matched?.id ?? modelId,
    supported: matched?.supportsFastMode ?? null
  }
}

const TRANSIENT_FAST_MODE_REASONS = new Set(['network_error', 'unknown', 'pending'])
const NON_BLOCKING_FAST_MODE_REASONS = new Set(['preference', 'sdk_opt_in_required'])

function claudeFastModeSupport(
  models: readonly ListedModel[],
  disabledReason: string | undefined
): AgentSessionFastModeSupport | undefined {
  if (disabledReason && TRANSIENT_FAST_MODE_REASONS.has(disabledReason)) {
    return undefined
  }
  if (disabledReason && !NON_BLOCKING_FAST_MODE_REASONS.has(disabledReason)) {
    return { supported: false, reason: disabledReason }
  }
  if (!models.some((model) => model.supportsFastMode === true)) {
    return models.length > 0 && models.every((model) => model.supportsFastMode === false)
      ? { supported: false, reason: 'model-not-supported' }
      : undefined
  }
  return { supported: true }
}

function listedModelFastModeSupport(
  models: readonly ListedModel[],
  modelId: string
): boolean | undefined {
  return matchListedModel(models, modelId)?.supportsFastMode
}

function decodedFastMode(session: ClaudeSession): boolean | undefined {
  const encoded = session.options.get('fastMode')
  if (encoded === undefined) {
    return undefined
  }
  const decoded = decodeStructuredAgentSessionOptionValue('fastMode', encoded)
  return typeof decoded === 'boolean' ? decoded : undefined
}

/**
 * Whether the catalog admits the model, matched by alias or resolved id so a pick
 * stored as either one is found. The permissive case lives here rather than at the
 * call site: every caller must treat an unidentified catalog the same way, and one
 * that forgot would refuse every model on a CLI that cannot answer.
 */
export function claudeCatalogAdmitsModel(models: readonly ListedModel[], modelId: string): boolean {
  // An empty list identifies no model, so it is not evidence against one — a live
  // CLI predating `list_models` would otherwise have every model refused under it.
  // Do not turn this into a refusal.
  return (
    models.length === 0 ||
    models.some((model) => model.id === modelId || model.resolvedModel === modelId)
  )
}

export async function readClaudeStructuredSessionOptions(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<AgentSessionOptionsResult> {
  const readMutationSequence = session.optionMutationSequence
  const readPermissionModeMutation = session.permissionModeMutationSequence
  const [catalog, settings] = await Promise.all([
    session.connection.supportedModels({ timeoutMs }).catch(() => null),
    session.connection.getSettings({ timeoutMs }).catch(() => null)
  ])
  if (settings !== null && readMutationSequence === session.optionMutationSequence) {
    const effort = readClaudeSettingsEffort(settings)
    const fastMode = readClaudeSettingsFastMode(settings)
    const perSessionOptIn = readClaudeSettingsFastModePerSessionOptIn(settings)
    if (effort) {
      session.reportedOptions.effort = effort
    }
    if (fastMode !== null) {
      session.reportedOptions.fastMode = fastMode
      if (decodedFastMode(session) !== undefined) {
        session.options.set('fastMode', String(fastMode))
      }
      session.confirmedOptions.add('fastMode')
    }
    if (perSessionOptIn !== null) {
      session.fastModePerSessionOptIn = perSessionOptIn
    }
  }
  if (
    settings !== null &&
    readPermissionModeMutation === session.permissionModeMutationSequence &&
    session.basePermissionMode &&
    (session.options.has('permissionMode') ||
      session.reportedPermissionModeMutation !== readPermissionModeMutation)
  ) {
    const permissionMode = readClaudeSettingsPermissionMode(settings)
    if (permissionMode) {
      session.reportedOptions.permissionMode = permissionMode
      session.reportedPermissionModeMutation = readPermissionModeMutation
      const desiredPermissionMode =
        session.options.get('permissionMode') ?? session.basePermissionMode
      if (desiredPermissionMode === permissionMode) {
        session.confirmedOptions.add('permissionMode')
      } else {
        session.confirmedOptions.delete('permissionMode')
      }
    }
  }
  const discovered = listedModels(catalog ? { models: catalog } : null)
  const models = discovered.length > 0 ? discovered : seedModels()
  const current = readClaudeCurrentModel(session)
  const model = currentModelId(models, current.id)
  if (!models.some((entry) => entry.id === model)) {
    models.push({ id: model, label: model, isDefault: false, efforts: [], resolvedModel: null })
  }
  const effort = session.options.get('effort') ?? session.reportedOptions.effort
  let desiredFastMode = decodedFastMode(session)
  if (
    desiredFastMode === true &&
    listedModelFastModeSupport(discovered, model) === false &&
    readMutationSequence === session.optionMutationSequence
  ) {
    session.options.set('fastMode', 'false')
    session.confirmedOptions.delete('fastMode')
    desiredFastMode = false
  }
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
  const support = claudeFastModeSupport(discovered, session.fastModeDisabledReason)
  const { value: permissionMode, reported: permissionModeReported } =
    claudePublishedPermissionMode(session)
  const confirmed = [
    ...(current.confirmed ? ['model'] : []),
    ...(effort && session.confirmedOptions.has('effort') ? ['effort'] : []),
    ...(fastMode !== undefined &&
    (session.confirmedOptions.has('fastMode') || !session.options.has('fastMode'))
      ? ['fastMode']
      : []),
    ...(permissionMode && (session.confirmedOptions.has('permissionMode') || permissionModeReported)
      ? ['permissionMode']
      : [])
  ]
  return {
    models: models.map((entry) => ({
      id: entry.id,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
      isDefault: entry.isDefault,
      efforts: entry.efforts,
      ...(entry.supportsFastMode !== undefined ? { supportsFastMode: entry.supportsFastMode } : {})
    })),
    ...(support ? { fastModeSupport: support } : {}),
    ...(session.basePermissionMode
      ? { permissionModeRestoreValue: session.basePermissionMode }
      : {}),
    current: {
      model,
      ...(effort ? { effort } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      ...(session.fastModeState ? { fastModeState: session.fastModeState } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(confirmed.length > 0 ? { confirmed } : {})
    }
  }
}
