import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../native-chat/structured-agent-command-resolution'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentCliVersionReader } from '../agent-cli-version-probe'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  runAgentModelCatalogListing,
  runAgentModelCatalogSession
} from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { AgentModelCatalogListingStoppedError } from '../native-chat/agent-model-catalog/agent-model-catalog-failures'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { createAcpAgentConnection } from './acp-agent-connection'
import { acpRunFolder } from './acp-private-temp'
import {
  acpListingNeedsChatFolder,
  type AcpLaunchSpec,
  type AcpModelDiscovery,
  type AcpSessionModelDiscovery
} from './acp-launch-specs'
import type { AcpSessionStarted, AcpSessionStartOptions } from './acp-session-setup'
import {
  checkAcpLaunchVersion,
  resolveAcpLaunchInvocation,
  type AcpLaunchInvocationDeps
} from './acp-structured-launch-resolution'
import { AcpStructuredOptions } from './acp-structured-options'
import type { InitializeResponse } from './generated/acp-protocol.generated'

/** Session-free capability boundary: no session methods are exposed. */
export type AcpModelCatalogConnection = {
  initialize(): Promise<InitializeResponse>
  requestSessionFreeExtension(method: string, params: unknown): Promise<unknown>
  close(): Promise<unknown>
}

export type AcpModelCatalogSessionConnection = Omit<
  AcpModelCatalogConnection,
  'requestSessionFreeExtension'
> & {
  start(options: AcpSessionStartOptions): Promise<AcpSessionStarted>
  deleteSession(sessionId: string): Promise<unknown>
}

export type AcpModelCatalogProbeDeps = AcpLaunchInvocationDeps & {
  probeVersion?: AgentCliVersionReader
  connect?: (launch: ProviderProcessLaunch) => AcpModelCatalogConnection
  connectSession?: (launch: ProviderProcessLaunch) => AcpModelCatalogSessionConnection
  runListing?: typeof runAgentModelCatalogListing
}

/** Uses the same binary, account and scrubbed environment as chats. */
export function createAcpModelCatalogProbe(
  spec: AcpLaunchSpec,
  deps: AcpModelCatalogProbeDeps
): AgentModelCatalogProbe {
  return async (accountHome, options): Promise<AgentModelCatalogSuccess> => {
    const operation = options?.operation ?? { signal: options?.signal }
    assertStructuredAgentResolutionCurrent(operation)
    const discovery = spec.modelDiscovery
    if (discovery.kind === 'unavailable') {
      throw new Error(discovery.reason)
    }
    const workspace = options?.workspacePath
    // Reject folderless session discovery before spawning even a version probe.
    if (!workspace && acpListingNeedsChatFolder(discovery)) {
      throw folderlessListing(spec)
    }
    // Start in home; only explicit chat-folder discovery reads project config.
    const cwd = deps.homePath ?? homedir()
    const { command, prefixArgs, env, envToDelete } = await resolveAcpLaunchInvocation(
      spec,
      accountHome,
      {
        ...deps,
        operation,
        resolveWorkingDirectory: () => cwd
      }
    )
    assertStructuredAgentResolutionCurrent(operation)
    const release = await checkAcpLaunchVersion(
      spec,
      { command, prefixArgs, cwd, env },
      discovery.kind === 'command' && discovery.supportsVersion !== undefined,
      deps.probeVersion
    )
    assertStructuredAgentResolutionCurrent(operation)
    if (release.status === 'tooOld') {
      throw new Error(`${spec.agent} at ${command} does not run structured chats`)
    }
    const listing = listingFor(discovery, release.version)
    if (listing === null) {
      throw new Error(`${spec.agent} at ${command} lists its models only through its chats`)
    }
    const launch = {
      command,
      args: [...prefixArgs, ...spec.args({ fullAccess: false, pluginDir: null })],
      cwd,
      env,
      envToDelete
    }
    const run = { label: spec.agent, signal: options?.signal }
    let models: AgentSessionModelOption[]
    if (listing.kind === 'command') {
      const stdout = await (deps.runListing ?? runAgentModelCatalogListing)(
        {
          command,
          args: [...prefixArgs, ...listing.args],
          cwd: workspace ?? cwd,
          env,
          envToDelete
        },
        { site: `${spec.agent}-model-catalog-probe`, signal: options?.signal }
      )
      models = listing.parse(stdout)
    } else if (listing.kind === 'session') {
      if (!workspace) {
        throw folderlessListing(spec)
      }
      // Remove disposable session storage after the process closes.
      const folderArgs = listing.sessionFolderArgs
      const folder = folderArgs
        ? await acpRunFolder(join(deps.dataDirectory, 'acp-listing-sessions', spec.agent))
        : null
      try {
        assertStructuredAgentResolutionCurrent(operation)
        const args =
          folderArgs && folder ? [...launch.args, ...folderArgs(folder.path)] : launch.args
        models = await runAgentModelCatalogSession(
          () => (deps.connectSession ?? createAcpAgentConnection)({ ...launch, args }),
          (connection) => readSessionModels(spec, listing, connection, workspace, operation),
          run
        )
      } finally {
        await folder?.remove()
      }
    } else {
      models = await runAgentModelCatalogSession(
        () => (deps.connect ?? createAcpAgentConnection)(launch),
        async (connection) => {
          const initialized = await connection.initialize()
          assertStructuredAgentResolutionCurrent(operation)
          return listing.read(initialized, connection)
        },
        run
      )
    }
    if (models.length === 0) {
      throw new Error(`${spec.agent} listed no models`)
    }
    return { models, origin: 'probe' }
  }
}

const folderlessListing = (spec: AcpLaunchSpec) =>
  new AgentModelCatalogListingStoppedError(`${spec.agent} lists in a chat's folder`)

type AcpModelListing = Exclude<AcpModelDiscovery, { kind: 'unavailable' }>

function listingFor(discovery: AcpModelListing, version: string | null): AcpModelListing | null {
  if (discovery.kind !== 'command' || !discovery.supportsVersion) {
    return discovery
  }
  if (version !== null && discovery.supportsVersion(version)) {
    return discovery
  }
  return discovery.otherReleasesListInSession
    ? { kind: 'session', listingNamesConfiguredModel: discovery.listingNamesConfiguredModel }
    : null
}

async function readSessionModels(
  spec: AcpLaunchSpec,
  listing: AcpSessionModelDiscovery,
  connection: AcpModelCatalogSessionConnection,
  workspace: string,
  operation?: StructuredAgentResolutionOperation
): Promise<AgentSessionModelOption[]> {
  const initialized = await connection.initialize()
  assertStructuredAgentResolutionCurrent(operation)
  const deletes = Boolean(initialized.agentCapabilities?.sessionCapabilities?.delete)
  if (!deletes && !listing.sessionFolderArgs) {
    throw new Error(`${spec.agent} cannot delete a session, so it lists its models only in chats`)
  }
  const started = await connection.start({ cwd: workspace, mcpServers: [] })
  // A failed delete or interrupted create may leave an empty conversation.
  if (deletes) {
    await connection.deleteSession(started.sessionId).catch((error: unknown) => {
      console.warn(`[acp-model-catalog] ${spec.agent} kept its listing session:`, error)
    })
  }
  const options = new AcpStructuredOptions(spec.dialect)
  options.adoptSession(started.response, 'new')
  return options.read().models
}
