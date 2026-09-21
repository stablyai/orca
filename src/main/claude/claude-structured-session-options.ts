import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice,
  AgentSessionOptionsResult
} from '../../shared/agent-session-wire'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import type { CatalogModel } from '../../shared/agent-session-option-catalog-types'
import type { ClaudeSession } from './claude-structured-session-state'

type ListedModel = AgentSessionModelOption & { resolvedModel: string | null }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * The session's current effort, which only `get_settings` reports: the
 * `system/init` frame carries `model` but has never carried an effort of any
 * kind. Null when the provider stops reporting it, so the pill goes empty
 * rather than showing an effort nothing measured.
 */
export function readClaudeSettingsEffort(settings: unknown): string | null {
  return text(record(record(settings)?.effective)?.effortLevel)
}

function effortLabel(value: string): string {
  return value === 'xhigh' ? 'Extra high' : `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

function listedEfforts(row: Record<string, unknown>): AgentSessionOptionChoice[] {
  return row.supportsEffort === true && Array.isArray(row.supportedEffortLevels)
    ? row.supportedEffortLevels.flatMap((value) => {
        const effort = text(value)
        return effort ? [{ value: effort, label: effortLabel(effort) }] : []
      })
    : []
}

function listedModels(value: unknown): ListedModel[] {
  const response = record(value)
  const rows = Array.isArray(response?.models)
    ? response.models.map(record).filter((row): row is Record<string, unknown> => row !== null)
    : []
  const defaultRow = rows.find((row) => text(row.value) === 'default')
  const defaultResolvedModel = text(defaultRow?.resolvedModel)
  const seen = new Set<string>()
  return rows.flatMap((row) => {
    const id = text(row.value)
    if (!id || id === 'default' || seen.has(id)) {
      return []
    }
    seen.add(id)
    const resolvedModel = text(row.resolvedModel)
    const description = text(row.description)
    return [
      {
        id,
        label: text(row.displayName) ?? id,
        ...(description ? { description } : {}),
        isDefault: resolvedModel !== null && resolvedModel === defaultResolvedModel,
        efforts: listedEfforts(row),
        resolvedModel
      }
    ]
  })
}

function seedEfforts(model: CatalogModel): AgentSessionOptionChoice[] {
  const effort = model.options.find((option) => option.id === 'effort')
  return effort?.kind.type === 'select' ? effort.kind.choices : []
}

function seedModels(): ListedModel[] {
  return CLAUDE_SESSION_OPTION_CATALOG.models.map((model) => ({
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    isDefault: model.isDefault === true,
    efforts: seedEfforts(model),
    resolvedModel: null
  }))
}

function currentModelId(models: ListedModel[], reportedModel: string | undefined): string {
  const matched = reportedModel
    ? models.find((model) => model.id === reportedModel || model.resolvedModel === reportedModel)
    : undefined
  return (
    matched?.id ?? reportedModel ?? models.find((model) => model.isDefault)?.id ?? models[0]!.id
  )
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
export async function readClaudeModelEffortLevels(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<{ modelId: string | undefined; levels: ReadonlySet<string> | null }> {
  const modelId = readClaudeCurrentModel(session).id
  if (!modelId) {
    return { modelId, levels: null }
  }
  const catalog = await session.connection.supportedModels({ timeoutMs }).catch(() => null)
  const matched = catalog
    ? listedModels({ models: catalog }).find(
        (model) => model.id === modelId || model.resolvedModel === modelId
      )
    : undefined
  return {
    modelId: matched?.id ?? modelId,
    levels: matched ? new Set(matched.efforts.map((choice) => choice.value)) : null
  }
}

export async function readClaudeStructuredSessionOptions(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<AgentSessionOptionsResult> {
  const catalog = await session.connection.supportedModels({ timeoutMs }).catch(() => null)
  const discovered = listedModels(catalog ? { models: catalog } : null)
  const models = discovered.length > 0 ? discovered : seedModels()
  const current = readClaudeCurrentModel(session)
  const model = currentModelId(models, current.id)
  if (!models.some((entry) => entry.id === model)) {
    models.push({ id: model, label: model, isDefault: false, efforts: [], resolvedModel: null })
  }
  const effort = session.options.get('effort') ?? session.reportedOptions.effort
  const confirmed = [
    ...(current.confirmed ? ['model'] : []),
    ...(effort && session.confirmedOptions.has('effort') ? ['effort'] : [])
  ]
  return {
    models: models.map((entry) => ({
      id: entry.id,
      label: entry.label,
      ...(entry.description ? { description: entry.description } : {}),
      isDefault: entry.isDefault,
      efforts: entry.efforts
    })),
    current: {
      model,
      ...(effort ? { effort } : {}),
      ...(confirmed.length > 0 ? { confirmed } : {})
    }
  }
}
