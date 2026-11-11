import { readFile } from 'node:fs/promises'
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
  provider: z.record(z.string(), providerConfigSchema).optional(),
  custom_provider: z.record(z.string(), providerConfigSchema).optional()
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
  const usedLabels = new Set<string>()
  let defaultAssigned = false
  // Custom providers keep their compound id (`custom_provider:<key>`), the same identity
  // mcode's own config uses when naming them.
  const providers = [
    ...Object.entries(parsed.data.provider ?? {}),
    ...Object.entries(parsed.data.custom_provider ?? {}).map(
      ([key, provider]) => [`custom_provider:${key}`, provider] as const
    )
  ]
  for (const [providerId, provider] of providers) {
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
      const qualifiedId = `${providerId}/${modelId}`
      if (seen.has(qualifiedId)) {
        continue
      }
      seen.add(qualifiedId)
      const baseLabel =
        MCODE_MODEL_LABELS[modelId] ?? (model.name ? `MiniMax ${model.name}` : modelId)
      // The same model id under another provider keeps the first label and qualifies the rest.
      const label = usedLabels.has(baseLabel)
        ? `${baseLabel} (${provider.name ?? providerId.replace(/^custom_provider:/, '')})`
        : baseLabel
      usedLabels.add(baseLabel)
      // A bare defaultModel matches every provider's copy; only the first match is the default.
      const isDefault =
        !defaultAssigned && (defaultModel === qualifiedId || defaultModel === modelId)
      if (isDefault) {
        defaultAssigned = true
      }
      models.push({
        id: `m:${providerId}:${modelId}:v:thinking`,
        label,
        description: mcodeModelDescription(modelId),
        isDefault,
        ...mcodeModelEfforts({ modelId })
      })
    }
  }
  if (models.length === 0) {
    throw new Error('mcode did not list its models')
  }
  return models
}

/** Reads and parses the config.yaml at `configPath`; read failures surface to discovery. */
export async function parseMcodeModelCatalogFromConfigFile(
  configPath: string
): Promise<AgentSessionModelOption[]> {
  return parseMcodeModelCatalog(await readFile(configPath, 'utf8'))
}

/**
 * mcode's ACP initialize carries no model list (its extension methods are all session-scoped),
 * so the CLI's config.yaml is the only session-free model source. `home` is the account home the
 * launch pins through MINIMAX_DATA_DIR, so the listing matches the config the session will read;
 * a read or parse failure surfaces as a discovery error instead of a silent fallback.
 */
export async function readMcodeModelCatalog(
  _initialized: InitializeResponse,
  _connection: { requestSessionFreeExtension(method: string, params: unknown): Promise<unknown> },
  home: string | null
): Promise<AgentSessionModelOption[]> {
  if (!home) {
    throw new Error('mcode discovery requires the pinned MINIMAX_DATA_DIR account home')
  }
  return parseMcodeModelCatalogFromConfigFile(join(home, 'config.yaml'))
}
