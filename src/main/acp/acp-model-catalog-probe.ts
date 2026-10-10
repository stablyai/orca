import { homedir } from 'node:os'
import { probeAgentCliVersion } from '../agent-cli-version-probe'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  runAgentModelCatalogListing,
  runAgentModelCatalogSession
} from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { createAcpAgentConnection } from './acp-agent-connection'
import type { AcpLaunchSpec } from './acp-launch-specs'
import {
  acpLaunchVersionSupported,
  resolveAcpLaunchInvocation,
  type AcpLaunchInvocationDeps
} from './acp-structured-launch-resolution'
import type { InitializeResponse } from './generated/acp-protocol.generated'

/** The part of an ACP connection a session-free listing may use: no session method is reachable. */
export type AcpModelCatalogConnection = {
  initialize(): Promise<InitializeResponse>
  requestSessionFreeExtension(method: string, params: unknown): Promise<unknown>
  close(): Promise<unknown>
}

export type AcpModelCatalogProbeDeps = AcpLaunchInvocationDeps & {
  /** Test seams; production spawns through the shared supervised runner and ACP connection. */
  probeVersion?: typeof probeAgentCliVersion
  connect?: (launch: ProviderProcessLaunch) => AcpModelCatalogConnection
  runListing?: typeof runAgentModelCatalogListing
}

/**
 * Lists an ACP agent's models without a session, under the binary, account and scrubbed
 * environment its chats launch with. A release that runs no structured chat lists nothing.
 */
export function createAcpModelCatalogProbe(
  spec: AcpLaunchSpec,
  deps: AcpModelCatalogProbeDeps
): AgentModelCatalogProbe {
  return async (accountHome, options): Promise<AgentModelCatalogSuccess> => {
    const discovery = spec.modelDiscovery
    // Registered as unavailable instead (`acpModelCatalogDiscovery`); never built for one.
    if (discovery.kind === 'unavailable') {
      throw new Error(discovery.reason)
    }
    const { command, env, envToDelete } = await resolveAcpLaunchInvocation(spec, accountHome, deps)
    // A listing reads no workspace: the catalog is the account's, whichever chat asks.
    const cwd = deps.homePath ?? homedir()
    if (
      !(await acpLaunchVersionSupported(
        spec,
        { command, cwd, env },
        deps.probeVersion ?? probeAgentCliVersion
      ))
    ) {
      throw new Error(`${spec.agent} at ${command} does not run structured chats`)
    }
    let models: AgentSessionModelOption[]
    if (discovery.kind === 'command') {
      const stdout = await (deps.runListing ?? runAgentModelCatalogListing)(
        { command, args: [...discovery.args], cwd, env, envToDelete },
        { site: `${spec.agent}-model-catalog-probe`, signal: options?.signal }
      )
      models = discovery.parse(stdout)
    } else {
      const launch = {
        command,
        args: spec.args({ fullAccess: false, pluginDir: null }),
        cwd,
        env,
        envToDelete
      }
      models = await runAgentModelCatalogSession(
        () => (deps.connect ?? createAcpAgentConnection)(launch),
        async (connection) => discovery.read(await connection.initialize(), connection),
        { label: spec.agent, signal: options?.signal }
      )
    }
    if (models.length === 0) {
      throw new Error(`${spec.agent} listed no models`)
    }
    return { models, fastModeTierByModel: new Map(), origin: 'probe' }
  }
}
