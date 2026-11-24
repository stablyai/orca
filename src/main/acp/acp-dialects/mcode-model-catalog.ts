import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import type { AgentSessionOptionChoice } from '../../../shared/agent-session/agent-session-wire'
import type { InitializeResponse } from '../generated/acp-protocol.generated'
import {
  MCODE_EFFORT_CHOICES,
  MCODE_MODEL_LABELS,
  MCODE_ON_OFF_EFFORT_CHOICES,
  MCODE_SESSION_OPTION_CATALOG,
  mcodeModelId,
  mcodeSharedModelLabels,
  parseMcodeModelId
} from '../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-mcode'
import { asRecord, arrayValue } from '../../ai-vault/parsing/session-record-fields'
import { extractString } from '../../../shared/text/trimmed-string'

type McodeModelEfforts = {
  efforts: AgentSessionOptionChoice[]
  defaultEffort?: string
  declaredDefaultEffort?: string | null
}

const modelConfigSchema = z.looseObject({})
const providerConfigSchema = z.looseObject({
  name: z.string().optional(),
  models: z.record(z.string(), modelConfigSchema).optional(),
  model_order: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  withdrawn: z.boolean().optional(),
  options: z.looseObject({ baseURL: z.string().optional() }).optional()
})
const configDocSchema = z.looseObject({
  defaultModel: z.string().optional(),
  defaultModelVariant: z.string().optional(),
  provider: z.record(z.string(), providerConfigSchema).optional(),
  custom_provider: z.record(z.string(), providerConfigSchema).optional()
})

type McodeConfigModel = z.infer<typeof modelConfigSchema>
type McodeConfigProvider = z.infer<typeof providerConfigSchema>

const CUSTOM_PROVIDER_PREFIX = 'custom_provider:'
const MCODE_OFFICIAL_PROVIDER = 'minimax'
const MCODE_OFFICIAL_GATEWAY_ORIGINS = new Set(
  ['agent.minimaxi.com', 'agent.minimax.io', 'agent.minimax.cn'].map((host) => `https://${host}`)
)

/** mcode's migrated copy of the official provider: `minimax-legacy` and its numbered aliases, where it
 *  names no base URL or targets an official gateway. mcode resolves it to official models only. */
function mcodeIsOfficialAlias(key: string, provider: McodeConfigProvider): boolean {
  if (!/^minimax-legacy(?:-\d+)?$/.test(key)) {
    return false
  }
  const { baseURL } = provider.options ?? {}
  if (!baseURL) {
    return true
  }
  try {
    const url = new URL(baseURL)
    return (
      !url.username && !url.password && MCODE_OFFICIAL_GATEWAY_ORIGINS.has(url.origin.toLowerCase())
    )
  } catch {
    return false
  }
}

/** Mirrors mcode: a disabled or withdrawn custom provider serves no model, and an official alias none of its own. */
function mcodeListsCustomProvider(key: string, provider: McodeConfigProvider): boolean {
  return (
    provider.enabled !== false &&
    provider.withdrawn !== true &&
    !mcodeIsOfficialAlias(key, provider)
  )
}

/** mcode resolves a default that names a migrated legacy copy to the official provider's model of the same
 *  name, never to another provider's copy of that model. */
function mcodeDefaultModel(
  defaultModel: string | undefined,
  customProviders: [string, McodeConfigProvider][]
): string {
  const reference = (defaultModel ?? '').split('#')[0]!
  const provider = reference.slice(0, reference.indexOf('/') + 1)
  const key = provider.slice(CUSTOM_PROVIDER_PREFIX.length, -1)
  const alias =
    provider.startsWith(CUSTOM_PROVIDER_PREFIX) &&
    customProviders.some(([name, config]) => name === key && mcodeIsOfficialAlias(name, config))
  return alias ? `${MCODE_OFFICIAL_PROVIDER}/${reference.slice(provider.length)}` : reference
}

const THINKING_SWITCH = 'thinking'
const THINKING_MODES = ['switchable', 'forced_on', 'forced_off'] as const
type McodeThinkingMode = (typeof THINKING_MODES)[number]

function stringList(value: unknown): string[] {
  return arrayValue(value).filter((item): item is string => extractString(item) !== null)
}

/** The efforts mcode's shipped catalog gives a model; a session's own menu says more once it runs the model. */
export function mcodeModelEfforts(model: { modelId: string }): McodeModelEfforts {
  const ref = parseMcodeModelId(model.modelId)
  // The shipped efforts describe the official provider's own model, never a custom provider's copy of it.
  const effort = MCODE_SESSION_OPTION_CATALOG.models
    .find((seed) => {
      const shipped = parseMcodeModelId(seed.id)
      return (
        shipped !== null &&
        ref !== null &&
        shipped.providerId === ref.providerId &&
        shipped.modelId === ref.modelId
      )
    })
    ?.options.find((option) => option.id === 'effort')
  return effort?.kind.type === 'select'
    ? {
        efforts: effort.kind.choices.map(({ value, label }) => ({ value, label })),
        defaultEffort: effort.kind.defaultValue,
        declaredDefaultEffort: effort.kind.defaultValue
      }
    : { efforts: [], declaredDefaultEffort: null }
}

/** The keys of `variants` are a model's selections; `none-thinking` is its off variant. */
function mcodeVariants(model: McodeConfigModel): string[] {
  return Object.entries(asRecord(model.variants) ?? {})
    .filter(([, variant]) => asRecord(variant)?.disabled !== true)
    .map(([name]) => (name === 'none-thinking' ? '' : name))
}

/** Mirrors mcode: `thinking_config` states the switch; a custom provider without one is forced on by effort levels. */
function mcodeThinking(
  model: McodeConfigModel,
  customProvider: boolean,
  defaultModelVariant: string | null
): { mode: McodeThinkingMode | undefined; thinkingOn: boolean; levels: string[] } {
  const config = asRecord(model.thinking_config)
  const levels = stringList(asRecord(model.thinking)?.effortOptions)
  const configured = THINKING_MODES.find((mode) => mode === extractString(config?.mode))
  const mode = configured ?? (customProvider && levels.length > 0 ? 'forced_on' : undefined)
  // `defaultModelVariant` decides a switch's default first; mcode spells its off variant `none-thinking`.
  const thinkingOn =
    mode === 'forced_on' ||
    (mode === 'switchable' &&
      (defaultModelVariant === THINKING_SWITCH ||
        (defaultModelVariant !== 'none-thinking' && config?.default_value === 'true')))
  return { mode, thinkingOn, levels }
}

function mcodeEfforts(
  thinking: ReturnType<typeof mcodeThinking>,
  model: McodeConfigModel
): McodeModelEfforts {
  const { levels } = thinking
  if (levels.length > 0) {
    // mcode falls back to the middle level when the configured default is not one of them.
    const configured = extractString(asRecord(model.thinking)?.defaultEffort)
    const defaultEffort =
      configured && levels.includes(configured)
        ? configured
        : levels[Math.floor(levels.length / 2)]!
    return {
      efforts: levels.map((level) => ({
        value: level,
        label:
          MCODE_EFFORT_CHOICES.find((choice) => choice.value === level)?.label ??
          `${level.charAt(0).toUpperCase()}${level.slice(1)}`
      })),
      defaultEffort,
      declaredDefaultEffort: defaultEffort
    }
  }
  const defaultEffort = thinking.thinkingOn ? 'on' : 'off'
  return thinking.mode === 'switchable'
    ? { efforts: MCODE_ON_OFF_EFFORT_CHOICES, defaultEffort, declaredDefaultEffort: defaultEffort }
    : { efforts: [], declaredDefaultEffort: null }
}

type McodeCatalogRow = McodeModelEfforts & {
  provider: string
  modelId: string
  qualifiedId: string
  id: string
  label: string
}

function mcodeProviderRows(
  provider: McodeConfigProvider,
  scope: { key: string; id: string; custom: boolean; defaultModelVariant: string | null }
): McodeCatalogRow[] {
  const order = provider.model_order ?? []
  return Object.entries(provider.models ?? {})
    .filter(([, model]) => model.enabled !== false)
    .sort(([a], [b]) => {
      const ia = order.indexOf(a)
      const ib = order.indexOf(b)
      if (ia !== -1 && ib !== -1) {
        return ia - ib
      }
      return ia !== -1 ? -1 : ib !== -1 ? 1 : 0
    })
    .map(([modelId, model]) => {
      const thinking = mcodeThinking(model, scope.custom, scope.defaultModelVariant)
      const variants = mcodeVariants(model)
      // A switchable model's row is its thinking row; its off variant is the effort choice.
      const variant =
        thinking.mode === 'forced_off'
          ? ''
          : thinking.mode !== undefined || variants.includes(THINKING_SWITCH)
            ? THINKING_SWITCH
            : variants[0]
      const name = extractString(model.name)
      return {
        provider: scope.key,
        modelId,
        qualifiedId: `${scope.id}/${modelId}`,
        id: mcodeModelId({ providerId: scope.id, modelId, variant }),
        label: MCODE_MODEL_LABELS[modelId] ?? (name ? `MiniMax ${name}` : modelId),
        ...mcodeEfforts(thinking, model)
      }
    })
}

/** Parses mcode's config.yaml model table; throws when the file names no model. */
export function parseMcodeModelCatalog(content: string): AgentSessionModelOption[] {
  const parsed = configDocSchema.safeParse(parseYaml(content))
  if (!parsed.success) {
    throw new Error('mcode config.yaml is not a readable model catalog')
  }
  const customProviders = Object.entries(parsed.data.custom_provider ?? {})
  // A bare defaultModel matches every provider's copy; only the first match is the default.
  const configured = mcodeDefaultModel(parsed.data.defaultModel, customProviders)
  const scope = { defaultModelVariant: extractString(parsed.data.defaultModelVariant) }
  // Custom providers keep their compound id (`custom_provider:<key>`), the identity mcode names them by.
  const rows = [
    ...Object.entries(parsed.data.provider ?? {}).flatMap(([key, provider]) =>
      mcodeProviderRows(provider, { ...scope, key, id: key, custom: false })
    ),
    ...customProviders
      .filter(([key, provider]) => mcodeListsCustomProvider(key, provider))
      .flatMap(([key, provider]) =>
        mcodeProviderRows(provider, {
          ...scope,
          key,
          id: `${CUSTOM_PROVIDER_PREFIX}${key}`,
          custom: true
        })
      )
  ]
  const sharedLabels = mcodeSharedModelLabels(rows.map((row) => row.label))
  let defaultAssigned = false
  const models = rows.map(({ provider, modelId, qualifiedId, label, ...option }) => {
    const isDefault = !defaultAssigned && (configured === qualifiedId || configured === modelId)
    if (isDefault) {
      defaultAssigned = true
    }
    return {
      ...option,
      // Two providers serving one model each name theirs.
      label: sharedLabels.has(label) ? `${label} (${provider})` : label,
      isDefault
    }
  })
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
