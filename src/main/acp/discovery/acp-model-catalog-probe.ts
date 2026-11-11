import { observeAcpForkSupport } from '../capabilities/acp-fork-support'
import { assertStructuredAgentResolutionCurrent } from '../../native-chat/structured-agent-command-resolution'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentCliVersionReader } from '../../agent-launch/preflight/agent-cli-version-probe'
import type { AgentModelCatalogProbe } from '../../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  AgentModelCatalogProbeError,
  runAgentModelCatalogListing,
  runAgentModelCatalogSession
} from '../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { AgentModelCatalogListingStoppedError } from '../../native-chat/agent-model-catalog/agent-model-catalog-failures'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import type { AgentSessionModelOption } from '../../../shared/agent-session/agent-session-wire'
import { createAcpAgentConnection } from '../process/acp-agent-connection'
import { acpLaunchSpecForAccount } from '../launch/acp-launch-command'
import { acpRunFolder } from '../launch/acp-private-temp'
import {
  acpListingDependsOnRelease,
  acpListingNeedsChatFolder,
  acpModelListingForRelease
} from './acp-model-discovery-policy'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { checkAcpLaunchVersion } from '../launch/acp-launch-version'
import {
  resolveAcpLaunchInvocation,
  type AcpLaunchInvocationDeps
} from '../launch/acp-structured-launch-resolution'
import {
  readSessionModels,
  type AcpModelCatalogConnection,
  type AcpModelCatalogSessionConnection
} from './acp-listing-session-models'
import { AcpAgentError, AcpAgentExitedError } from '../transport/acp-errors'
import { AgentModelCatalogUnavailableError } from '../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { usesModelSpecificAcpEfforts } from '../../../shared/agent-session/options/agent-model-catalog-ownership'

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
  const probe: AgentModelCatalogProbe = async (accountHome, options) => {
    const operation = options?.operation ?? { signal: options?.signal }
    assertStructuredAgentResolutionCurrent(operation)
    const activeSpec = acpLaunchSpecForAccount(spec, accountHome)
    const discovery = activeSpec.modelDiscovery
    if (discovery.kind === 'unavailable') {
      throw new Error(discovery.reason)
    }
    const workspace = options?.workspacePath
    // Reject folderless session discovery before spawning even a version probe.
    if (!workspace && acpListingNeedsChatFolder(discovery)) {
      throw folderlessListing(activeSpec)
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
      activeSpec,
      { command, prefixArgs, cwd, env },
      acpListingDependsOnRelease(discovery),
      deps.probeVersion
    )
    assertStructuredAgentResolutionCurrent(operation)
    if (release.status === 'tooOld') {
      throw new Error(`${activeSpec.agent} at ${command} does not run structured chats`)
    }
    const listing = acpModelListingForRelease(discovery, release.version)
    if (listing === null) {
      throw new Error(`${activeSpec.agent} at ${command} lists its models only through its chats`)
    }
    const launch = {
      command,
      args: [...prefixArgs, ...activeSpec.args({ fullAccess: false, pluginDir: null })],
      cwd,
      env,
      envToDelete
    }
    const run = { label: activeSpec.agent, signal: options?.signal }
    // OMP records every model switch as account usage; starting on the picked model records none.
    const launchedModel =
      activeSpec.launchesWithModel && usesModelSpecificAcpEfforts(activeSpec.agent)
        ? options?.selectedModels?.[0]
        : undefined
    let models: AgentSessionModelOption[]
    let attemptedModels: string[] | undefined
    if (listing.kind === 'command') {
      const stdout = await (deps.runListing ?? runAgentModelCatalogListing)(
        {
          command,
          args: [...prefixArgs, ...listing.args],
          cwd: workspace ?? cwd,
          env,
          envToDelete
        },
        { site: `${activeSpec.agent}-model-catalog-probe`, signal: options?.signal }
      )
      models = listing.parse(stdout)
      if (models.length === 0 && listing.isNotSignedInOutput?.(stdout)) {
        const account = activeSpec.dialect.signInAccount
        throw new AgentModelCatalogUnavailableError({
          reason: 'notSignedIn',
          ...(account ? { account } : {})
        })
      }
    } else if (listing.kind === 'session') {
      if (!workspace) {
        throw folderlessListing(activeSpec)
      }
      // Remove disposable session storage after the process closes.
      const folderArgs = listing.sessionFolderArgs
      const listInSession = async (model: string | undefined) => {
        const folder = folderArgs
          ? await acpRunFolder(join(deps.dataDirectory, 'acp-listing-sessions', activeSpec.agent))
          : null
        try {
          assertStructuredAgentResolutionCurrent(operation)
          const args = [
            ...prefixArgs,
            ...activeSpec.args({ fullAccess: false, pluginDir: null, model }),
            ...(folderArgs && folder ? folderArgs(folder.path) : [])
          ]
          return await runAgentModelCatalogSession(
            () => (deps.connectSession ?? createAcpAgentConnection)({ ...launch, args }),
            (connection, ready) =>
              readSessionModels(
                activeSpec,
                listing,
                connection,
                workspace,
                operation,
                options?.selectedModels,
                model,
                activeSpec.dialect.effortChangesModel ? ready : undefined
              ),
            run
          )
        } finally {
          await folder?.remove()
        }
      }
      let result: Awaited<ReturnType<typeof listInSession>>
      try {
        result = await listInSession(launchedModel)
      } catch (error) {
        // OMP exits before ACP on a model it cannot start (a stale `:level` id); list without it.
        if (launchedModel === undefined || !(error instanceof AcpAgentExitedError)) {
          throw error
        }
        assertStructuredAgentResolutionCurrent(operation)
        result = { ...(await listInSession(undefined)), attemptedModels: [launchedModel] }
      }
      models = result.models
      attemptedModels = result.attemptedModels
    } else {
      models = await runAgentModelCatalogSession(
        () => (deps.connect ?? createAcpAgentConnection)(launch),
        async (connection) => {
          const initialized = await connection.initialize()
          assertStructuredAgentResolutionCurrent(operation)
          observeAcpForkSupport(activeSpec.agent, initialized)
          return listing.read(initialized, connection)
        },
        run
      )
    }
    if (models.length === 0) {
      throw new Error(`${activeSpec.agent} listed no models`)
    }
    return { models, origin: 'probe', ...(attemptedModels ? { attemptedModels } : {}) }
  }
  return Object.assign(
    async (
      home: Parameters<AgentModelCatalogProbe>[0],
      options?: Parameters<AgentModelCatalogProbe>[1]
    ) => {
      try {
        return await probe(home, options)
      } catch (error) {
        const activeSpec = acpLaunchSpecForAccount(spec, home)
        const account = activeSpec.dialect.signInAccount
        const commandSignedOut =
          error instanceof AgentModelCatalogProbeError &&
          (error.reason === 'exit' || error.reason === 'timeout') &&
          error.failedExit !== undefined &&
          activeSpec.modelDiscovery.kind === 'command' &&
          activeSpec.modelDiscovery.isNotSignedInOutput?.(
            `${error.failedExit.stdout}\n${error.failedExit.stderr}`
          ) === true
        if ((error instanceof AcpAgentError && error.code === -32000) || commandSignedOut) {
          throw new AgentModelCatalogUnavailableError({
            reason: 'notSignedIn',
            ...(account ? { account } : {})
          })
        }
        throw error
      }
    },
    {
      supportsAccount: (home: Parameters<AgentModelCatalogProbe>[0]) =>
        acpLaunchSpecForAccount(spec, home).modelDiscovery.kind !== 'unavailable'
    }
  )
}

const folderlessListing = (spec: AcpLaunchSpec) =>
  new AgentModelCatalogListingStoppedError(`${spec.agent} lists in a chat's folder`)
