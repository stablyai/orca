import { assertStructuredAgentResolutionCurrent } from '../native-chat/structured-agent-command-resolution'
import { homedir } from 'node:os'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { parsePiModels } from '../../shared/commit-message-model-parsers'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { AgentCliVersionReader } from '../agent-cli-version-probe'
import { JsonlRpcAgentConnection } from '../jsonl-rpc/agent-connection'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  runAgentModelCatalogListing,
  runAgentModelCatalogSession
} from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { buildPiRpcLaunch, piRpcSessionlessEnvironment } from './rpc-launch'
import { checkPiRpcVersion, resolvePiRpcInvocation } from './rpc-launch-resolution'
import { readPiRpcModelOptions, type PiRpcRequester } from './rpc-options'

type PiModelCatalogConnection = PiRpcRequester & { close(): Promise<unknown> }

export type PiModelCatalogProbeDeps = {
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  /** Refresh once on a missing Pi binary; absent disables retry. */
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  resolveCommand?: typeof resolveCliCommand
  probeVersion?: AgentCliVersionReader
  connect?: (launch: ProviderProcessLaunch) => PiModelCatalogConnection
  runListing?: typeof runAgentModelCatalogListing
  homePath?: string
}

/** The text listing has no per-model thinking map; offer the levels every reasoning model keeps. */
export function piModelCatalogFromListing(stdout: string): AgentModelCatalogSuccess['models'] {
  return parsePiModels(stdout).map((model) => ({
    id: model.id,
    label: model.label,
    isDefault: false,
    efforts: model.thinkingLevels
      ? ['off', 'minimal', 'low', 'medium', 'high'].map((level) => ({ value: level, label: level }))
      : []
  }))
}

function connectPiModelCatalog(launch: ProviderProcessLaunch): PiModelCatalogConnection {
  const connection: JsonlRpcAgentConnection = new JsonlRpcAgentConnection(launch, {
    // Nobody can answer an extension's dialog during discovery; cancelling lets Pi continue.
    onRecord: (frame) => {
      if (
        frame.type === 'extension_ui_request' &&
        (typeof frame.id === 'string' || typeof frame.id === 'number')
      ) {
        void connection
          .send({ type: 'extension_ui_response', id: frame.id, cancelled: true })
          .catch(() => undefined)
      }
    }
  })
  return connection
}

export function createPiModelCatalogProbe(deps: PiModelCatalogProbeDeps): AgentModelCatalogProbe {
  return async (accountHome, options): Promise<AgentModelCatalogSuccess> => {
    const operation = options?.operation ?? { signal: options?.signal }
    assertStructuredAgentResolutionCurrent(operation)
    const cwd = deps.homePath ?? homedir()
    const { env, command, prefixArgs } = await resolvePiRpcInvocation({
      operation,
      accountDir: requireLegacyAgentSessionAccountHome(accountHome).path,
      resolveEnvironment: deps.resolveEnvironment,
      commandSettings: deps.resolveCommandSettings?.(),
      resolveCommand: deps.resolveCommand,
      refreshEnvironmentAfterMiss: deps.refreshEnvironmentAfterMiss,
      resolveWorkingDirectory: () => cwd
    })
    assertStructuredAgentResolutionCurrent(operation)
    const release = await checkPiRpcVersion({ command, prefixArgs, cwd, env }, deps.probeVersion)
    assertStructuredAgentResolutionCurrent(operation)
    if (release.status === 'tooOld') {
      throw new Error(`pi at ${command} does not run structured chats`)
    }
    const launch = buildPiRpcLaunch({
      command,
      prefixArgs,
      cwd,
      ...piRpcSessionlessEnvironment(env),
      fullAccess: true
    })
    let models: AgentModelCatalogSuccess['models']
    try {
      models = await runAgentModelCatalogSession(
        () =>
          (deps.connect ?? connectPiModelCatalog)({
            ...launch,
            args: [...launch.args, '--no-session']
          }),
        readPiRpcModelOptions,
        { label: 'pi', signal: options?.signal }
      )
    } catch (error) {
      if (options?.signal?.aborted) {
        throw error
      }
      // Pi reads RPC input only after extensions start, so a startup dialog can block it; the listing exits first.
      const stdout = await (deps.runListing ?? runAgentModelCatalogListing)(
        { ...launch, args: [...prefixArgs, '--list-models'] },
        { site: 'pi-model-catalog-probe', signal: options?.signal }
      )
      models = piModelCatalogFromListing(stdout)
    }
    if (models.length === 0) {
      throw new Error('pi listed no models')
    }
    return { models, origin: 'probe' }
  }
}
