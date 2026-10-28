import { homedir } from 'node:os'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { parsePiModels } from '../../shared/commit-message-model-parsers'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { AgentCliVersionReader } from '../agent-cli-version-probe'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { runAgentModelCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import { buildPiRpcLaunch, piRpcSessionlessEnvironment } from './rpc-launch'
import { checkPiRpcVersion, resolvePiRpcInvocation } from './rpc-launch-resolution'
import { PI_UNMAPPED_THINKING_LEVELS } from './rpc-options'

export type PiModelCatalogProbeDeps = {
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  /** Refresh once on a missing Pi binary; absent disables retry. */
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  resolveCommand?: typeof resolveCliCommand
  probeVersion?: AgentCliVersionReader
  runListing?: typeof runAgentModelCatalogListing
  homePath?: string
}

/** Listings omit default/model-specific thinking choices; expose only levels common to reasoning maps. */
export function piModelCatalogFromListing(stdout: string): AgentModelCatalogSuccess['models'] {
  return parsePiModels(stdout).map((model) => ({
    id: model.id,
    label: model.label,
    isDefault: false,
    efforts: model.thinkingLevels
      ? PI_UNMAPPED_THINKING_LEVELS.map((level) => ({ value: level, label: level }))
      : []
  }))
}

export function createPiModelCatalogProbe(deps: PiModelCatalogProbeDeps): AgentModelCatalogProbe {
  return async (accountHome, options): Promise<AgentModelCatalogSuccess> => {
    const cwd = deps.homePath ?? homedir()
    const { env, command } = await resolvePiRpcInvocation({
      accountDir: requireLegacyAgentSessionAccountHome(accountHome).path,
      resolveEnvironment: deps.resolveEnvironment,
      commandSettings: deps.resolveCommandSettings?.(),
      resolveCommand: deps.resolveCommand,
      refreshEnvironmentAfterMiss: deps.refreshEnvironmentAfterMiss,
      resolveWorkingDirectory: () => cwd
    })
    if ((await checkPiRpcVersion({ command, cwd, env }, deps.probeVersion)).status === 'tooOld') {
      throw new Error(`pi at ${command} does not run structured chats`)
    }
    const launch = buildPiRpcLaunch({
      command,
      cwd,
      ...piRpcSessionlessEnvironment(env),
      fullAccess: true
    })
    const stdout = await (deps.runListing ?? runAgentModelCatalogListing)(
      { ...launch, args: ['--list-models'] },
      { site: 'pi-model-catalog-probe', signal: options?.signal }
    )
    const models = piModelCatalogFromListing(stdout)
    if (models.length === 0) {
      throw new Error('pi listed no models')
    }
    return { models, origin: 'probe' }
  }
}
