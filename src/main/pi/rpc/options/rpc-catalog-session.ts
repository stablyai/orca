import type { AgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { resolveCliCommand } from '../../../../shared/shell/command-resolution/node-cli-command-resolution'
import type { AgentCliVersionReader } from '../../../agent-launch/preflight/agent-cli-version-probe'
import { JsonlRpcAgentConnection } from '../../../jsonl-rpc/agent-connection'
import { runAgentModelCatalogSession } from '../../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentCommandSettings,
  type StructuredAgentResolutionOperation
} from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import type { ProviderProcessLaunch } from '../../../provider-process/provider-process-launch'
import { buildPiRpcLaunch, piRpcSessionlessEnvironment } from '../launch/rpc-launch'
import { checkPiRpcVersion, resolvePiRpcInvocation } from '../launch/rpc-launch-resolution'
import type { PiRpcRequester } from './rpc-model-options'

type PiCatalogConnection = PiRpcRequester & { close(): Promise<unknown> }

export type PiRpcCatalogSessionDeps = {
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  resolveCommand?: typeof resolveCliCommand
  probeVersion?: AgentCliVersionReader
  connect?: (launch: ProviderProcessLaunch) => PiCatalogConnection
}

/** Cancel startup dialogs because a disposable probe has no chat UI to answer them. */
function connectPiCatalog(launch: ProviderProcessLaunch): PiCatalogConnection {
  const connection: JsonlRpcAgentConnection = new JsonlRpcAgentConnection(launch, {
    // Pi cannot read replies to session_start dialogs before binding.
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

/** Read a catalog in a caller-isolated, unsaved Pi process and await cleanup on every outcome. */
export async function runPiRpcCatalogSession<T>(
  deps: PiRpcCatalogSessionDeps,
  input: {
    accountHome: AgentSessionAccountHome
    cwd: string
    signal?: AbortSignal
    operation?: StructuredAgentResolutionOperation
  },
  read: (connection: PiRpcRequester) => Promise<T>
): Promise<T> {
  const operation = input.operation ?? { signal: input.signal }
  assertStructuredAgentResolutionCurrent(operation)
  const { env, command, prefixArgs } = await resolvePiRpcInvocation({
    operation,
    accountDir: requireLegacyAgentSessionAccountHome(input.accountHome).path,
    resolveEnvironment: deps.resolveEnvironment,
    commandSettings: deps.resolveCommandSettings?.(),
    resolveCommand: deps.resolveCommand,
    refreshEnvironmentAfterMiss: deps.refreshEnvironmentAfterMiss,
    resolveWorkingDirectory: () => input.cwd
  })
  return runResolvedPiRpcCatalogSession(
    deps,
    { command, prefixArgs, cwd: input.cwd, env, operation },
    read,
    { signal: input.signal ?? operation.signal }
  )
}

/** Keep resolved model probes and workspace command scans on the same sessionless lifecycle. */
export async function runResolvedPiRpcCatalogSession<T>(
  deps: Pick<PiRpcCatalogSessionDeps, 'probeVersion' | 'connect'>,
  input: Parameters<typeof checkPiRpcVersion>[0],
  read: (connection: PiRpcRequester) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number | null } = {}
): Promise<T> {
  const { command, prefixArgs, cwd, env, operation } = input
  assertStructuredAgentResolutionCurrent(operation)
  const release = await checkPiRpcVersion(input, deps.probeVersion)
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
  return runAgentModelCatalogSession(
    () => (deps.connect ?? connectPiCatalog)({ ...launch, args: [...launch.args, '--no-session'] }),
    read,
    { label: 'pi', ...options }
  )
}
