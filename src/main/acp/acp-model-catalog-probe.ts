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

/** The part of an ACP connection a session-free listing may use: no session method is reachable. */
export type AcpModelCatalogConnection = {
  initialize(): Promise<InitializeResponse>
  requestSessionFreeExtension(method: string, params: unknown): Promise<unknown>
  close(): Promise<unknown>
}

/** A connection that may open one session, to read what a new chat offers, and delete it. */
export type AcpModelCatalogSessionConnection = Omit<
  AcpModelCatalogConnection,
  'requestSessionFreeExtension'
> & {
  start(options: AcpSessionStartOptions): Promise<AcpSessionStarted>
  deleteSession(sessionId: string): Promise<unknown>
}

export type AcpModelCatalogProbeDeps = AcpLaunchInvocationDeps & {
  /** Test seams; production spawns through the shared supervised runner and ACP connection. */
  probeVersion?: AgentCliVersionReader
  connect?: (launch: ProviderProcessLaunch) => AcpModelCatalogConnection
  connectSession?: (launch: ProviderProcessLaunch) => AcpModelCatalogSessionConnection
  runListing?: typeof runAgentModelCatalogListing
}

/**
 * Lists an ACP agent's models before a chat, under the binary, account and scrubbed environment its
 * chats launch with. A release that runs no structured chat lists nothing, nor does one its
 * discovery names no listing for.
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
    const workspace = options?.workspacePath
    // Known without spawning anything: a listing that may open a session needs a chat's folder.
    if (!workspace && acpListingNeedsChatFolder(discovery)) {
      throw folderlessListing(spec)
    }
    // Spawned from home; a listing reads a project's config only in the chat folder it is asked for.
    const cwd = deps.homePath ?? homedir()
    const { command, env, envToDelete } = await resolveAcpLaunchInvocation(spec, accountHome, {
      ...deps,
      resolveWorkingDirectory: () => cwd
    })
    const release = await checkAcpLaunchVersion(
      spec,
      { command, cwd, env },
      discovery.kind === 'command' && discovery.supportsVersion !== undefined,
      deps.probeVersion
    )
    if (release.status === 'tooOld') {
      throw new Error(`${spec.agent} at ${command} does not run structured chats`)
    }
    const listing = listingFor(discovery, release.version)
    if (listing === null) {
      throw new Error(`${spec.agent} at ${command} lists its models only through its chats`)
    }
    const launch = {
      command,
      args: spec.args({ fullAccess: false, pluginDir: null }),
      cwd,
      env,
      envToDelete
    }
    const run = { label: spec.agent, signal: options?.signal }
    let models: AgentSessionModelOption[]
    if (listing.kind === 'command') {
      const stdout = await (deps.runListing ?? runAgentModelCatalogListing)(
        { command, args: [...listing.args], cwd: workspace ?? cwd, env, envToDelete },
        { site: `${spec.agent}-model-catalog-probe`, signal: options?.signal }
      )
      models = listing.parse(stdout)
    } else if (listing.kind === 'session') {
      if (!workspace) {
        throw folderlessListing(spec)
      }
      // Kept out of the agent's own store, and removed once `close` has ended the process.
      const folderArgs = listing.sessionFolderArgs
      const folder = folderArgs
        ? await acpRunFolder(join(deps.dataDirectory, 'acp-listing-sessions', spec.agent))
        : null
      try {
        const args =
          folderArgs && folder ? [...launch.args, ...folderArgs(folder.path)] : launch.args
        models = await runAgentModelCatalogSession(
          () => (deps.connectSession ?? createAcpAgentConnection)({ ...launch, args }),
          (connection) => readSessionModels(spec, listing, connection, workspace),
          run
        )
      } finally {
        await folder?.remove()
      }
    } else {
      models = await runAgentModelCatalogSession(
        () => (deps.connect ?? createAcpAgentConnection)(launch),
        async (connection) => listing.read(await connection.initialize(), connection),
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

/** How `version` lists: its discovery, unless that is a command this release has no listing for. */
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

/** What a new chat in `workspace` offers, read from a session opened only to be deleted, or kept
 *  in a folder the probe removes. */
async function readSessionModels(
  spec: AcpLaunchSpec,
  listing: AcpSessionModelDiscovery,
  connection: AcpModelCatalogSessionConnection,
  workspace: string
): Promise<AgentSessionModelOption[]> {
  const initialized = await connection.initialize()
  const deletes = Boolean(initialized.agentCapabilities?.sessionCapabilities?.delete)
  if (!deletes && !listing.sessionFolderArgs) {
    throw new Error(`${spec.agent} cannot delete a session, so it lists its models only in chats`)
  }
  const started = await connection.start({ cwd: workspace, mcpServers: [] })
  // Best effort: a failed delete, or a listing stopped mid-create, leaves one empty conversation.
  if (deletes) {
    await connection.deleteSession(started.sessionId).catch((error: unknown) => {
      console.warn(`[acp-model-catalog] ${spec.agent} kept its listing session:`, error)
    })
  }
  const options = new AcpStructuredOptions(spec.dialect)
  options.adoptSession(started.response, 'new')
  return options.read().models
}
