import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice,
  AgentSessionOptionsResult
} from '../../shared/agent-session-wire'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexOpenedThread } from './codex-structured-thread-open'
import type { CodexSession } from './codex-structured-session-state'
import { isCodexTurnOptionKey } from './codex-structured-turn-start'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'

const MODEL_PAGE_LIMIT = 100
const MAX_MODEL_PAGES = 20

export function restoredCodexSessionOptions(
  options: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  return new Map(Object.entries(options ?? {}).filter(([key]) => isCodexTurnOptionKey(key)))
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function effortLabel(value: string): string {
  return value === 'xhigh'
    ? 'Extra high'
    : value === 'minimal'
      ? 'Minimal'
      : `${value.charAt(0).toUpperCase()}${value.slice(1)}`
}

function effortChoice(value: unknown): AgentSessionOptionChoice | null {
  const row = record(value)
  const effort = text(row?.reasoningEffort)
  if (!effort) {
    return null
  }
  const description = text(row?.description)
  return {
    value: effort,
    label: effortLabel(effort),
    ...(description ? { description } : {})
  }
}

function modelOption(value: unknown): AgentSessionModelOption | null {
  const row = record(value)
  if (!row) {
    return null
  }
  const id = text(row.model) ?? text(row.id)
  const label = text(row.displayName) ?? id
  if (!id || !label || row.hidden === true) {
    return null
  }
  const description = text(row.description)
  const defaultEffort = text(row.defaultReasoningEffort)
  const efforts = Array.isArray(row.supportedReasoningEfforts)
    ? row.supportedReasoningEfforts
        .map(effortChoice)
        .filter((choice): choice is AgentSessionOptionChoice => choice !== null)
    : []
  return {
    id,
    label,
    ...(description ? { description } : {}),
    isDefault: row.isDefault === true,
    ...(defaultEffort ? { defaultEffort } : {}),
    efforts
  }
}

export async function readCodexStructuredSessionOptions(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  current: { model?: string; effort?: string }
  timeoutMs?: number
}): Promise<AgentSessionOptionsResult> {
  const models: AgentSessionModelOption[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const response = record(
      await input.connection.request(
        'model/list',
        { limit: MODEL_PAGE_LIMIT, includeHidden: false, ...(cursor ? { cursor } : {}) },
        { timeoutMs: input.timeoutMs }
      )
    )
    const rows = Array.isArray(response?.data) ? response.data : []
    for (const row of rows) {
      const parsed = modelOption(row)
      if (parsed && !models.some((model) => model.id === parsed.id)) {
        models.push(parsed)
      }
    }
    cursor = text(response?.nextCursor)
    if (!cursor) {
      break
    }
  }
  if (input.current.model && !models.some((model) => model.id === input.current.model)) {
    models.push({
      id: input.current.model,
      label: input.current.model,
      isDefault: false,
      efforts: []
    })
  }
  const model = input.current.model ?? models.find((entry) => entry.isDefault)?.id ?? models[0]?.id
  if (!model) {
    throw new Error('codex app-server returned no available models')
  }
  return {
    models,
    current: { model, ...(input.current.effort ? { effort: input.current.effort } : {}) }
  }
}

export function reportedCodexThreadOptions(
  opened: CodexOpenedThread
): CodexSession['reportedOptions'] {
  return {
    ...(opened.model ? { model: opened.model } : {}),
    ...(opened.effort ? { effort: opened.effort } : {})
  }
}

export function readLiveCodexSessionOptions(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<AgentSessionOptionsResult> {
  const model = session.options.get('model') ?? session.reportedOptions.model
  const effort = session.options.get('effort') ?? session.reportedOptions.effort
  return readCodexStructuredSessionOptions({
    connection: session.connection,
    current: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
    timeoutMs
  })
}

export async function applyCodexStructuredSessionOption(
  session: CodexSession,
  key: string,
  value: string,
  timeoutMs: number | undefined
): Promise<Readonly<Record<string, string>>> {
  try {
    return await applyValidatedCodexStructuredSessionOption(session, key, value, timeoutMs)
  } catch (error) {
    throw new AgentSessionOptionRejectedError(error)
  }
}

async function applyValidatedCodexStructuredSessionOption(
  session: CodexSession,
  key: string,
  value: string,
  timeoutMs: number | undefined
): Promise<Readonly<Record<string, string>>> {
  if (key !== 'model' && key !== 'effort') {
    session.options.set(key, value)
    return Object.fromEntries(session.options)
  }
  const priorModel = session.options.get('model') ?? session.reportedOptions.model
  const priorEffort = session.options.get('effort') ?? session.reportedOptions.effort
  const catalog = await readCodexStructuredSessionOptions({
    connection: session.connection,
    current: {
      ...(priorModel ? { model: priorModel } : {}),
      ...(priorEffort ? { effort: priorEffort } : {})
    },
    timeoutMs
  })
  if (key === 'model' && !catalog.models.some((entry) => entry.id === value)) {
    throw new Error(`codex app-server does not offer model ${value}`)
  }
  const modelId = key === 'model' ? value : catalog.current.model
  const model = catalog.models.find((entry) => entry.id === modelId)
  const requestedEffort = key === 'effort' ? value : priorEffort
  if (
    key === 'effort' &&
    (!model?.efforts.length || !model.efforts.some((effort) => effort.value === requestedEffort))
  ) {
    throw new Error(`codex app-server model ${modelId} does not support ${value}`)
  }
  const effort =
    model?.efforts.length === 0
      ? undefined
      : (model?.efforts.find((entry) => entry.value === requestedEffort)?.value ??
        model?.defaultEffort ??
        model?.efforts[0]?.value)
  session.options.set('model', modelId)
  if (effort) {
    session.options.set('effort', effort)
  } else {
    session.options.delete('effort')
  }
  return Object.fromEntries(session.options)
}
