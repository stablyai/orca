import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/agent-session-options-result'
import { effectiveServiceTier } from '../../../../shared/agent-session/options/structured-agent-session-effective-tier'
import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import { structuredAgentSessionOptionModels } from '../../../native-chat/agent-session-wire/options/structured-agent-session-option-models'
import {
  CODEX_DEFAULT_SERVICE_TIER,
  codexFastModeOfServiceTier,
  codexFastModeSupport,
  codexFastServiceTier,
  readCodexServiceTiers
} from './codex-structured-service-tier'
import {
  applyCodexConfiguredLaunchDefaults,
  readCodexConfiguredLaunchDefaults
} from '../launch/codex-configured-launch-defaults'

const MODEL_PAGE_LIMIT = 100
const MAX_MODEL_PAGES = 20

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
  const serviceTiers = readCodexServiceTiers(row)
  return {
    id,
    label,
    ...(description ? { description } : {}),
    isDefault: row.isDefault === true,
    ...(defaultEffort ? { defaultEffort } : {}),
    declaredDefaultEffort: defaultEffort ?? null,
    efforts,
    ...(!Array.isArray(row.supportedReasoningEfforts) ||
    efforts.length !== row.supportedReasoningEfforts.length
      ? { effortsKnown: false as const }
      : {}),
    ...(serviceTiers
      ? { serviceTiers, supportsFastMode: codexFastServiceTier({ serviceTiers }) !== undefined }
      : {})
  }
}

export type CodexSessionOptionCatalog = AgentSessionOptionsResult

export type CodexModelCatalogListing = {
  models: AgentSessionModelOption[]
  complete?: boolean
  configured?: { model?: string; effort?: string }
  /** Retain installed tiers when the current child's model row overrides its controls. */
  listedServiceTiers?: readonly string[]
}

export type CodexModelPages = {
  models: AgentSessionModelOption[]
  /** False when a page was malformed, a row unreadable, or the page cap cut the listing short. */
  complete: boolean
}

/** Pages `model/list` (hidden rows excluded) through any transport's request. */
export async function listCodexModelPages(
  request: (params: Record<string, unknown>) => Promise<unknown>
): Promise<CodexModelPages> {
  const models: AgentSessionModelOption[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  let complete = true
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const response = record(
      await request({
        limit: MODEL_PAGE_LIMIT,
        includeHidden: false,
        ...(cursor ? { cursor } : {})
      })
    )
    if (!Array.isArray(response?.data)) {
      complete = false
    }
    const rows = Array.isArray(response?.data) ? response.data : []
    for (const row of rows) {
      const parsed = modelOption(row)
      if (!parsed && record(row)?.hidden !== true) {
        complete = false
      }
      if (parsed && !seen.has(parsed.id)) {
        seen.add(parsed.id)
        models.push(parsed)
      }
    }
    if (
      response?.nextCursor !== null &&
      response?.nextCursor !== undefined &&
      !text(response.nextCursor)
    ) {
      complete = false
    }
    cursor = text(response?.nextCursor)
    if (!cursor) {
      break
    }
  }
  return { models, complete: complete && cursor === null }
}

export async function fetchCodexModelCatalogListing(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  timeoutMs?: number
  deadlineMs?: number
  cwd?: string
  operation?: StructuredAgentResolutionOperation
}): Promise<CodexModelCatalogListing> {
  const deadline = Math.min(
    input.operation?.deadline ?? Infinity,
    input.deadlineMs === undefined ? Infinity : Date.now() + input.deadlineMs
  )
  const remainingTimeout = (): number | undefined => {
    assertStructuredAgentResolutionCurrent(input.operation)
    if (!Number.isFinite(deadline)) {
      return input.timeoutMs
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error('codex model listing deadline exceeded')
    }
    return Math.min(remaining, input.timeoutMs ?? remaining)
  }
  const { models: parsedModels, complete } = await listCodexModelPages((params) =>
    input.connection
      .request('model/list', params, { timeoutMs: remainingTimeout() })
      .then((response) => {
        assertStructuredAgentResolutionCurrent(input.operation)
        return response
      })
  )
  const configured = await readCodexConfiguredLaunchDefaults(
    input.connection,
    remainingTimeout(),
    input.cwd
  )
  assertStructuredAgentResolutionCurrent(input.operation)
  return {
    models: applyCodexConfiguredLaunchDefaults(parsedModels, configured),
    complete: complete && configured !== null,
    ...(configured
      ? {
          configured: {
            ...(configured.model ? { model: configured.model } : {}),
            ...(configured.effort ? { effort: configured.effort } : {})
          }
        }
      : {})
  }
}

export function composeCodexSessionOptionCatalog(
  listing: CodexModelCatalogListing,
  input: {
    current: { model?: string; effort?: string; serviceTier?: string }
    reportedServiceTier?: string | null
    reportedServiceTierKnown?: boolean
  }
): CodexSessionOptionCatalog {
  const models = structuredAgentSessionOptionModels(
    applyCodexConfiguredLaunchDefaults(
      listing.models,
      listing.configured
        ? { model: listing.configured.model ?? null, effort: listing.configured.effort ?? null }
        : null
    ).map((entry) => ({ ...entry })),
    input.current.model,
    (row) => row
  )
  const model = input.current.model
  const reportedTier = input.reportedServiceTierKnown
    ? (input.reportedServiceTier ?? CODEX_DEFAULT_SERVICE_TIER)
    : undefined
  const selectedTier = input.current.serviceTier ?? reportedTier
  const modelTiers = models.find((row) => row.id === model)?.serviceTiers
  const serviceTier =
    selectedTier && modelTiers
      ? effectiveServiceTier({
          tier: selectedTier,
          modelTiers: modelTiers.map((row) => row.value),
          listedTiers:
            listing.listedServiceTiers ??
            models.flatMap((row) => row.serviceTiers?.map((tier) => tier.value) ?? []),
          reported: selectedTier === reportedTier
        })
      : selectedTier
  // Older clients only read Fast; any other tier leaves their toggle unset.
  const fastMode = codexFastModeOfServiceTier(
    serviceTier,
    models.find((entry) => entry.id === model)
  )
  const support = codexFastModeSupport(models)
  return {
    models,
    ...(support ? { fastModeSupport: support } : {}),
    current: {
      ...(model ? { model } : {}),
      ...(input.current.effort ? { effort: input.current.effort } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      ...(reportedTier !== undefined && input.current.serviceTier === undefined
        ? { confirmed: fastMode === undefined ? ['serviceTier'] : ['serviceTier', 'fastMode'] }
        : {})
    }
  }
}
