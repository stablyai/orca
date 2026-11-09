import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session/agent-session-wire'
import type { InitializeResponse } from '../generated/acp-protocol.generated'
import {
  MCODE_EFFORT_CHOICES,
  MCODE_MODEL_LABELS,
  MCODE_ON_OFF_EFFORT_CHOICES,
  mcodeModelDescription
} from '../../../shared/agent-session/options/agent-session-option-catalog-mcode'

const providerConfigSchema = z.looseObject({
  name: z.string().optional(),
  models: z.record(z.string(), z.looseObject({ name: z.string().optional() })).optional(),
  model_order: z.array(z.string()).optional()
})
const configDocSchema = z.looseObject({
  defaultModel: z.string().optional(),
  provider: z.record(z.string(), providerConfigSchema).optional()
})

/** Session menus and config parsing share this id-based effort mapping. */
export function mcodeModelEfforts(model: { modelId: string }): {
  efforts: AgentSessionOptionChoice[]
  defaultEffort?: string
  declaredDefaultEffort?: string | null
} {
  const idLower = model.modelId.toLowerCase()
  if (idLower.includes('flash')) {
    return {
      efforts: MCODE_EFFORT_CHOICES,
      defaultEffort: 'high',
      declaredDefaultEffort: 'high'
    }
  }
  if (idLower.includes('m3') || idLower.includes('m2.7')) {
    return {
      efforts: MCODE_ON_OFF_EFFORT_CHOICES,
      defaultEffort: 'on',
      declaredDefaultEffort: 'on'
    }
  }
  return {
    efforts: [],
    declaredDefaultEffort: null
  }
}

/** Parses mcode's config.yaml model table; throws when the file names no model. */
export function parseMcodeModelCatalog(content: string): AgentSessionModelOption[] {
  const parsed = configDocSchema.safeParse(parseYaml(content))
  if (!parsed.success) {
    throw new Error('mcode config.yaml is not a readable model catalog')
  }
  const { defaultModel = '' } = parsed.data
  const models: AgentSessionModelOption[] = []
  const seen = new Set<string>()
  for (const [providerId, provider] of Object.entries(parsed.data.provider ?? {})) {
    const order = provider.model_order ?? []
    const entries = Object.entries(provider.models ?? {}).sort(([a], [b]) => {
      const ia = order.indexOf(a)
      const ib = order.indexOf(b)
      if (ia !== -1 && ib !== -1) {
        return ia - ib
      }
      return ia !== -1 ? -1 : ib !== -1 ? 1 : 0
    })
    for (const [modelId, model] of entries) {
      if (modelId === 'MiniMax-M3.1-Flash-Preview' || seen.has(modelId)) {
        continue
      }
      seen.add(modelId)
      models.push({
        id: `m:${providerId}:${modelId}:v:thinking`,
        label: MCODE_MODEL_LABELS[modelId] ?? (model.name ? `MiniMax ${model.name}` : modelId),
        description: mcodeModelDescription(modelId),
        isDefault: defaultModel === `${providerId}/${modelId}` || defaultModel === modelId,
        ...mcodeModelEfforts({ modelId })
      })
    }
  }
  if (models.length === 0) {
    throw new Error('mcode did not list its models')
  }
  return models
}

export async function parseMcodeModelCatalogFromConfigFile(
  configPath: string
): Promise<AgentSessionModelOption[]> {
  return parseMcodeModelCatalog(await readFile(configPath, 'utf8'))
}

/**
 * mcode's ACP initialize carries no model list (its extension methods are all session-scoped),
 * so the CLI's config.yaml is the only session-free model source; a read or parse failure
 * surfaces as a discovery error instead of a silent fallback.
 */
export async function readMcodeModelCatalog(
  _initialized: InitializeResponse,
  _connection: { requestSessionFreeExtension(method: string, params: unknown): Promise<unknown> }
): Promise<AgentSessionModelOption[]> {
  const dataDir = process.env.MINIMAX_DATA_DIR?.trim() || join(homedir(), '.minimax')
  return parseMcodeModelCatalogFromConfigFile(join(dataDir, 'config.yaml'))
}
