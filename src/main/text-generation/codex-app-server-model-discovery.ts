import type { CommitMessageModelCapability } from '../../shared/commit-message-agent-spec'
import { planAgentBinary } from '../../shared/commit-message-plan'
import { resolveCliCommand } from '../codex-cli/command'
import { runCodexAppServerSession } from '../codex/codex-app-server-session'
import { getSpawnArgsForWindows } from '../win32-utils'
import { staticModelDiscoveryResult } from './commit-message-model-discovery-policy'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'
import type {
  DiscoverCommitMessageModelsResult,
  LocalProcessExecution
} from './source-control-text-generation-types'
import type { getAgentModelProbeSpec } from '../../shared/agent-model-probe-spec'

export function parseCodexAppServerModelDiscovery(
  modelList: unknown,
  configRead: unknown
): { models: CommitMessageModelCapability[]; defaultModelId: string } | null {
  const listRecord =
    typeof modelList === 'object' && modelList !== null
      ? (modelList as Record<string, unknown>)
      : null
  const rows = Array.isArray(listRecord?.data) ? listRecord.data : []
  const configRoot =
    typeof configRead === 'object' && configRead !== null
      ? (configRead as Record<string, unknown>)
      : null
  const config =
    typeof configRoot?.config === 'object' && configRoot.config !== null
      ? (configRoot.config as Record<string, unknown>)
      : null
  const configuredModel = typeof config?.model === 'string' ? config.model.trim() : ''
  const configuredEffort =
    typeof config?.model_reasoning_effort === 'string' ? config.model_reasoning_effort.trim() : ''
  let providerDefault = ''
  const models = rows.flatMap((row): CommitMessageModelCapability[] => {
    if (typeof row !== 'object' || row === null) {
      return []
    }
    const record = row as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id || record.hidden === true) {
      return []
    }
    if (record.isDefault === true) {
      providerDefault = id
    }
    const efforts = Array.isArray(record.supportedReasoningEfforts)
      ? record.supportedReasoningEfforts.flatMap((value): { id: string; label: string }[] => {
          if (typeof value !== 'object' || value === null) {
            return []
          }
          const effort = (value as Record<string, unknown>).reasoningEffort
          if (typeof effort !== 'string' || !effort.trim()) {
            return []
          }
          const normalized = effort.trim()
          return [
            {
              id: normalized,
              label:
                normalized === 'xhigh'
                  ? 'Extra high'
                  : normalized.charAt(0).toUpperCase() + normalized.slice(1)
            }
          ]
        })
      : []
    const providerEffort =
      typeof record.defaultReasoningEffort === 'string' ? record.defaultReasoningEffort.trim() : ''
    const defaultThinkingLevel =
      id === configuredModel && configuredEffort ? configuredEffort : providerEffort
    return [
      {
        id,
        label:
          typeof record.displayName === 'string' && record.displayName.trim()
            ? record.displayName.trim()
            : id,
        ...(efforts.length > 0
          ? {
              thinkingLevels: efforts,
              defaultThinkingLevel: defaultThinkingLevel || efforts[0]!.id
            }
          : {})
      }
    ]
  })
  if (models.length === 0) {
    return null
  }
  return {
    models,
    defaultModelId:
      (configuredModel && models.some((model) => model.id === configuredModel)
        ? configuredModel
        : providerDefault) || models[0]!.id
  }
}

export function startCodexAppServerModelDiscovery(input: {
  spec: NonNullable<ReturnType<typeof getAgentModelProbeSpec>>
  env: NodeJS.ProcessEnv | undefined
  agentCommandOverride?: string
}): LocalProcessExecution<DiscoverCommitMessageModelsResult> {
  const result = (async (): Promise<DiscoverCommitMessageModelsResult> => {
    const command = planAgentBinary('codex', input.agentCommandOverride)
    if (!command.ok) {
      return { success: false, error: command.error }
    }
    const spawnEnv = input.env ?? process.env
    const resolvedBinary =
      process.platform === 'win32'
        ? resolveCliCommand(command.binary, { pathEnv: spawnEnv.PATH ?? spawnEnv.Path ?? null })
        : command.binary
    const invocation = getSpawnArgsForWindows(resolvedBinary, [...command.prefixArgs, 'app-server'])
    try {
      const discovered = await runCodexAppServerSession(
        {
          command: invocation.spawnCmd,
          args: invocation.spawnArgs,
          cliPath: resolvedBinary,
          env: spawnEnv as Record<string, string>,
          timeoutMs: SOURCE_CONTROL_GENERATION_TIMEOUT_MS
        },
        async (rpc) => {
          const [models, config] = await Promise.all([
            rpc.request('model/list', {}),
            rpc.request('config/read', {})
          ])
          return parseCodexAppServerModelDiscovery(models, config)
        }
      )
      return discovered
        ? staticModelDiscoveryResult(
            input.spec,
            discovered.models,
            discovered.defaultModelId,
            'probe'
          )
        : { success: false, error: 'Codex returned no available models.' }
    } catch (error) {
      console.error('[commit-message] Codex app-server model discovery failed:', error)
      return {
        success: false,
        error: 'Codex model discovery failed. Check the Codex CLI configuration and try again.'
      }
    }
  })()
  return {
    result,
    processClosed: result.then(
      () => undefined,
      () => undefined
    )
  }
}
