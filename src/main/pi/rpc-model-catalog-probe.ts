import { homedir } from 'node:os'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { parsePiModels } from '../../shared/commit-message-model-parsers'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { probeAgentCliVersion } from '../agent-cli-version-probe'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { runAgentModelCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import { buildPiRpcLaunch } from './rpc-launch'
import { piRpcVersionSupported, resolvePiRpcCommand } from './rpc-launch-resolution'
import { PI_UNMAPPED_THINKING_LEVELS } from './rpc-options'

export type PiModelCatalogProbeDeps = {
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  resolveCommand?: typeof resolveCliCommand
  /** Test seams; production runs the shared supervised listing. */
  probeVersion?: typeof probeAgentCliVersion
  runListing?: typeof runAgentModelCatalogListing
  homePath?: string
}

/** Pi's table names each model and whether it reasons; its live thinking menu is model-specific,
 *  so a reasoning model lists the levels every map keeps and names no default. */
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

/** Lists Pi's models with `pi --list-models`, under the binary and environment its chats run. */
export function createPiModelCatalogProbe(deps: PiModelCatalogProbeDeps): AgentModelCatalogProbe {
  return async (accountHome, options): Promise<AgentModelCatalogSuccess> => {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(await deps.resolveEnvironment())) {
      if (value !== undefined) {
        env[key] = value
      }
    }
    env.PI_CODING_AGENT_DIR = requireLegacyAgentSessionAccountHome(accountHome).path
    const command = resolvePiRpcCommand(env, deps.resolveCommandSettings?.(), deps.resolveCommand)
    const cwd = deps.homePath ?? homedir()
    if (!(await piRpcVersionSupported({ command, cwd, env }, deps.probeVersion))) {
      throw new Error(`pi at ${command} does not run structured chats`)
    }
    // The chat launch's own env rules; only the arguments differ.
    const launch = buildPiRpcLaunch({ command, cwd, env, fullAccess: true })
    const stdout = await (deps.runListing ?? runAgentModelCatalogListing)(
      { ...launch, args: ['--list-models'] },
      { site: 'pi-model-catalog-probe', signal: options?.signal }
    )
    const models = piModelCatalogFromListing(stdout)
    if (models.length === 0) {
      throw new Error('pi listed no models')
    }
    return { models, fastModeTierByModel: new Map(), origin: 'probe' }
  }
}
