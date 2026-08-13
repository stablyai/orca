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

export async function readClaudeStructuredSessionOptions(
  session: ClaudeSession,
  timeoutMs: number | undefined
): Promise<AgentSessionOptionsResult> {
  const response = await session.connection
    .request('list_models', {}, { timeoutMs })
    .catch(() => null)
  const discovered = listedModels(response)
  const models = discovered.length > 0 ? discovered : seedModels()
  const reportedModel = session.options.get('model') ?? session.reportedOptions.model
  const model = currentModelId(models, reportedModel)
  if (!models.some((entry) => entry.id === model)) {
    models.push({ id: model, label: model, isDefault: false, efforts: [], resolvedModel: null })
  }
  const effort = session.options.get('effort') ?? session.reportedOptions.effort
  return {
    models: models.map(({ resolvedModel: _, ...entry }) => entry),
    current: { model, ...(effort ? { effort } : {}) }
  }
}
