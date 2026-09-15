import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../shared/agent-session-wire'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import type { CatalogModel } from '../../shared/agent-session-option-catalog-types'

export type ListedModel = AgentSessionModelOption & { resolvedModel: string | null }

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
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

export function listedModels(value: unknown): ListedModel[] {
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

    const supportsFastMode =
      typeof row.supportsFastMode === 'boolean' ? row.supportsFastMode : undefined

    return [
      {
        id,
        label: text(row.displayName) ?? id,
        ...(description ? { description } : {}),
        isDefault: resolvedModel !== null && resolvedModel === defaultResolvedModel,
        efforts: listedEfforts(row),
        ...(supportsFastMode !== undefined ? { supportsFastMode } : {}),
        resolvedModel
      }
    ]
  })
}

/** Alias matcher for the Fast-mode guards: a pick stored as an alias, as the resolved
 *  id, or as the literal `default` finds the same row. The effort and admit guards
 *  match on alias and resolved id only — neither ever resolved `default`, and widening
 *  them here would tighten what they refuse. */
export function matchListedModel(
  models: readonly ListedModel[],
  modelId: string
): ListedModel | undefined {
  return models.find(
    (model) =>
      model.id === modelId ||
      model.resolvedModel === modelId ||
      (modelId === 'default' && model.isDefault)
  )
}

function seedEfforts(model: CatalogModel): AgentSessionOptionChoice[] {
  const effort = model.options.find((option) => option.id === 'effort')

  return effort?.kind.type === 'select' ? effort.kind.choices : []
}

export function seedModels(): ListedModel[] {
  return CLAUDE_SESSION_OPTION_CATALOG.models.map((model) => ({
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    isDefault: model.isDefault === true,
    efforts: seedEfforts(model),
    resolvedModel: null
  }))
}

export function currentModelId(models: ListedModel[], reportedModel: string | undefined): string {
  const matched = reportedModel
    ? models.find(
        (model) =>
          model.id === reportedModel ||
          model.resolvedModel === reportedModel ||
          (reportedModel === 'default' && model.isDefault)
      )
    : undefined

  return (
    matched?.id ?? reportedModel ?? models.find((model) => model.isDefault)?.id ?? models[0]!.id
  )
}
