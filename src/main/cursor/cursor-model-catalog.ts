import { createHash } from 'node:crypto'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import type { CursorSdkListedModel, CursorSdkModelSelection } from './cursor-sdk-protocol'

const DEFAULT_MODEL_IDS = ['composer-2.5', 'auto']
const CURSOR_MODEL_LIST_RETRY_MS = 1_000
const EFFORT_PARAM_IDS = ['reasoning_effort', 'effort', 'reasoning']

function parameter(
  model: CursorSdkListedModel,
  ids: readonly string[]
): NonNullable<CursorSdkListedModel['parameters']>[number] | undefined {
  return model.parameters?.find((entry) => ids.includes(entry.id))
}

function choiceLabel(value: string, displayName: string | undefined): string {
  if (displayName) {
    return displayName
  }
  if (value === 'true') {
    return 'On'
  }
  if (value === 'false') {
    return 'Off'
  }
  return value
}

function parameterChoices(
  model: CursorSdkListedModel,
  ids: readonly string[]
): { id: string; choices: { value: string; label: string }[]; defaultValue?: string } | null {
  const listed = parameter(model, ids)
  const choices = (listed?.values ?? []).map((value) => ({
    value: value.value,
    label: choiceLabel(value.value, value.displayName)
  }))
  if (!listed || choices.length === 0) {
    return null
  }
  const variantDefault = model.variants
    ?.find((variant) => variant.isDefault)
    ?.params.find((param) => param.id === listed.id)?.value
  const defaultValue = choices.some((choice) => choice.value === variantDefault)
    ? variantDefault
    : choices[0]?.value
  return { id: listed.id, choices, ...(defaultValue ? { defaultValue } : {}) }
}

/** Tokens in a Cursor context-window id such as `256k` or `1m`. */
export function cursorContextWindowTokens(value: string | undefined): number | null {
  const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value?.trim() ?? '')
  if (!match) {
    return null
  }
  const amount = Number(match[1])
  return Math.round(amount * (match[2]!.toLowerCase() === 'm' ? 1_000_000 : 1_000))
}

export function cursorSelectedContextWindowTokens(
  options: Readonly<Record<string, string>>,
  models: readonly CursorSdkListedModel[]
): number | null {
  const listed = models.find((model) => model.id === options.model?.trim())
  const context = listed ? parameterChoices(listed, ['context']) : null
  return cursorContextWindowTokens(options.context || context?.defaultValue)
}

export type CursorModelListCache = {
  models: CursorSdkListedModel[]
  scope: string | null
  failedScope: string | null
  failedAt: number
}

export function emptyCursorModelListCache(): CursorModelListCache {
  return { models: [], scope: null, failedScope: null, failedAt: 0 }
}

/** A failed list retries on a later read. A burst of reads does not spawn a sidecar each time. */
export async function refreshCursorModelList(
  cache: CursorModelListCache,
  input: {
    listModels?: (apiKey: string | undefined) => Promise<CursorSdkListedModel[]>
    resolveApiKey?: () => string | undefined
  }
): Promise<void> {
  if (!input.listModels) {
    return
  }
  const scope = cursorCatalogCredentialScope(input.resolveApiKey?.())
  if (cache.scope === scope) {
    return
  }
  if (cache.failedScope === scope && Date.now() - cache.failedAt < CURSOR_MODEL_LIST_RETRY_MS) {
    return
  }
  try {
    cache.models = await input.listModels(input.resolveApiKey?.()?.trim() || undefined)
    cache.scope = scope
    cache.failedScope = null
  } catch {
    cache.models = []
    cache.scope = null
    cache.failedScope = scope
    cache.failedAt = Date.now()
  }
}

export function cursorCatalogCredentialScope(apiKey: string | undefined): string {
  const key = apiKey?.trim()
  return key ? createHash('sha256').update(key).digest('hex') : 'browser-login'
}

export function cursorPreferredModelId(models: readonly CursorSdkListedModel[]): string {
  return (
    DEFAULT_MODEL_IDS.map((id) => models.find((model) => model.id === id)).find(Boolean)?.id ??
    models[0]?.id ??
    'auto'
  )
}

export function cursorModelsToSessionOptions(
  models: readonly CursorSdkListedModel[]
): AgentSessionModelOption[] {
  const preferredId = cursorPreferredModelId(models)
  return models.map((model) => {
    const effort = parameterChoices(model, EFFORT_PARAM_IDS)
    const context = parameterChoices(model, ['context'])
    const thinking = parameterChoices(model, ['thinking'])
    const fast = model.parameters?.some((entry) => entry.id === 'fast') ?? false
    return {
      id: model.id,
      label: model.displayName || model.id,
      ...(model.description ? { description: model.description } : {}),
      isDefault: model.id === preferredId,
      ...(effort?.defaultValue ? { defaultEffort: effort.defaultValue } : {}),
      efforts: effort?.choices ?? [],
      ...(context && context.choices.length > 1
        ? {
            contextWindows: context.choices,
            ...(context.defaultValue ? { defaultContextWindow: context.defaultValue } : {})
          }
        : {}),
      ...(thinking && thinking.choices.length > 1
        ? {
            thinkingLevels: thinking.choices,
            ...(thinking.defaultValue ? { defaultThinking: thinking.defaultValue } : {})
          }
        : {}),
      ...(fast ? { supportsFastMode: true } : {})
    }
  })
}

function variantParamValue(model: CursorSdkListedModel, paramId: string): string | undefined {
  return model.variants
    ?.find((variant) => variant.isDefault)
    ?.params.find((param) => param.id === paramId)?.value
}

function selectedParam(
  options: Readonly<Record<string, string>>,
  optionKey: string,
  modelId: string,
  models: readonly CursorSdkListedModel[],
  ids: readonly string[]
): { id: string; value: string } | null {
  const listed = models.find((model) => model.id === modelId)
  const resolved = listed ? parameterChoices(listed, ids) : null
  if (!listed || !resolved) {
    return null
  }
  const chosen = options[optionKey]
  const value =
    chosen && resolved.choices.some((choice) => choice.value === chosen)
      ? chosen
      : variantParamValue(listed, resolved.id)
  return value ? { id: resolved.id, value } : null
}

export function cursorModelSelection(
  options: Readonly<Record<string, string>>,
  models: readonly CursorSdkListedModel[]
): CursorSdkModelSelection {
  const id = options.model?.trim() || cursorPreferredModelId(models)
  const params = [
    selectedParam(options, 'effort', id, models, EFFORT_PARAM_IDS),
    selectedParam(options, 'context', id, models, ['context']),
    selectedParam(options, 'thinking', id, models, ['thinking']),
    options.fastMode === 'true' ? { id: 'fast', value: 'true' } : null
  ].flatMap((param) => (param ? [param] : []))
  return params.length > 0 ? { id, params } : { id }
}
