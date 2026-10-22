import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AgentSessionOptionChoice } from '../../shared/agent-session-wire'
import type { AgentModelCatalogProbe } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentModelCatalogSuccess } from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { initializeMspClient, spawnMspClient } from './msp-client'
import type { MspModelCatalogEntry } from './msp-protocol'
import {
  museStructuredVersionSupported,
  resolveMuseServeInvocation
} from './muse-structured-launch-resolution'

const MUSE_EFFORT_VALUES = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
] as const
const MUSE_EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

function museEfforts(entry: MspModelCatalogEntry): AgentSessionOptionChoice[] {
  const variants = Array.isArray(entry.reasoningEffortVariants)
    ? entry.reasoningEffortVariants.filter((value): value is string =>
        MUSE_EFFORT_VALUES.includes(value as (typeof MUSE_EFFORT_VALUES)[number])
      )
    : []
  const values = variants.length > 0 ? variants : [...MUSE_EFFORT_VALUES]
  return values.map((value) => ({ value, label: MUSE_EFFORT_LABELS[value] ?? value }))
}

export function museModelCatalogFromEntries(
  entries: MspModelCatalogEntry[]
): AgentModelCatalogSuccess['models'] {
  return entries
    .filter((entry) => entry.isActive !== false)
    .map((entry) => ({
      id: entry.modelId,
      label: entry.displayLabel ?? entry.modelId,
      ...(entry.description ? { description: entry.description } : {}),
      isDefault: entry.isDefault ?? false,
      ...(entry.defaultReasoningEffort ? { defaultEffort: entry.defaultReasoningEffort } : {}),
      efforts: museEfforts(entry)
    }))
}

/** Lists Muse's models over an ephemeral `serve` host: no chat starts for it. */
export function createMuseModelCatalogProbe(deps: {
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
}): AgentModelCatalogProbe {
  return async (accountHome, options) => {
    const accountDir = requireLegacyAgentSessionAccountHome(accountHome).path
    const cwd = options?.workspacePath ?? accountDir
    const baseEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(await deps.resolveEnvironment())) {
      if (value !== undefined) {
        baseEnv[key] = value
      }
    }
    const { env, command } = await resolveMuseServeInvocation({
      accountHomePath: accountDir,
      resolveEnvironment: async () => baseEnv,
      refreshEnvironmentAfterMiss: deps.refreshEnvironmentAfterMiss,
      resolveWorkingDirectory: () => cwd
    })
    if (!(await museStructuredVersionSupported({ command, cwd, env }))) {
      throw new Error(`muse at ${command} does not run structured chats`)
    }
    const client = spawnMspClient({ command, args: ['serve'], cwd, env })
    try {
      await initializeMspClient(client, { name: 'orca-model-catalog', version: '0' })
      const result = await client.request<{ models: MspModelCatalogEntry[] }>('model/list', {})
      return { models: museModelCatalogFromEntries(result.models ?? []), origin: 'probe' as const }
    } finally {
      await client.close('SIGKILL').catch(() => undefined)
    }
  }
}
