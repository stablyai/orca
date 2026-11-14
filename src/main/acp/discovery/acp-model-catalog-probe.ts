import { readAgentCliVersion } from '../../agent-launch/preflight/agent-cli-version-probe'
import { observeAcpForkSupport } from '../capabilities/acp-fork-support'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../../native-chat/agent-launch/structured-agent-command-resolution'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentCliVersionReader } from '../../agent-launch/preflight/agent-cli-version-probe'
import type {
  AgentModelCatalogProgress,
  AgentModelCatalogProbe,
  AgentModelCatalogLookup
} from '../../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import { agentModelCatalogInputStamp } from '../../native-chat/agent-model-catalog/agent-model-catalog-input-stamp'
import {
  runAgentModelCatalogListing,
  runAgentModelCatalogSession
} from '../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { AgentModelCatalogListingStoppedError } from '../../native-chat/agent-model-catalog/agent-model-catalog-failures'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import type { AgentSessionModelOption } from '../../../shared/agent-session/agent-session-wire'
import { createAcpAgentConnection } from '../process/acp-agent-connection'
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
  resolveSavedEnvironment?: () => Promise<Record<string, string>>
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
  const resolve = async (
    accountHome: Parameters<AgentModelCatalogProbe>[0],
    workspace: string,
    lookup: AgentModelCatalogLookup = 'recover',
    operation?: StructuredAgentResolutionOperation
  ) => {
    assertStructuredAgentResolutionCurrent(operation)
    const discovery = spec.modelDiscovery
    if (discovery.kind === 'unavailable') {
      throw new Error(discovery.reason)
    }
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
        ...(lookup !== 'recover'
          ? {
              resolveEnvironment: deps.resolveSavedEnvironment ?? deps.resolveEnvironment,
              refreshEnvironmentAfterMiss: undefined
            }
          : {}),
        operation,
        resolveWorkingDirectory: () => cwd
      }
    )
    assertStructuredAgentResolutionCurrent(operation)
    return {
      identity: { command, prefixArgs, cwd, workspace },
      inputStamp: JSON.stringify(
        await Promise.all(
          [
            ...new Set([cwd, ...(discovery.kind === 'command' && workspace ? [workspace] : [])])
          ].map((directory) =>
            agentModelCatalogInputStamp({ command, prefixArgs, cwd: directory, env })
          )
        )
      ),
      run: async (
        signal?: AbortSignal,
        runOperation = operation,
        selectedModels?: readonly string[],
        publish?: AgentModelCatalogProgress
      ) => {
        const options = { signal, operation: runOperation, selectedModels }
        const operation = runOperation
        assertStructuredAgentResolutionCurrent(operation)
        const release = await checkAcpLaunchVersion(
          spec,
          { command, prefixArgs, cwd, env, operation },
          acpListingDependsOnRelease(discovery),
          deps.probeVersion ?? ((input) => readAgentCliVersion({ ...input, timeoutMs: null }))
        )
        assertStructuredAgentResolutionCurrent(operation)
        if (release.status === 'tooOld') {
          throw new Error(`${spec.agent} at ${command} does not run structured chats`)
        }
        const listing = acpModelListingForRelease(discovery, release.version)
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
        const run = { label: spec.agent, signal: options?.signal, timeoutMs: null }
        // OMP records every model switch as account usage; starting on the picked model records none.
        const launchedModel =
          spec.launchesWithModel && usesModelSpecificAcpEfforts(spec.agent)
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
            { site: `${spec.agent}-model-catalog-probe`, signal: options?.signal, timeoutMs: null }
          )
          models = listing.parse(stdout)
        } else if (listing.kind === 'session') {
          if (!workspace) {
            throw folderlessListing(spec)
          }
          // Remove disposable session storage after the process closes.
          const folderArgs = listing.sessionFolderArgs
          const listInSession = async (model: string | undefined) => {
            const folder = folderArgs
              ? await acpRunFolder(join(deps.dataDirectory, 'acp-listing-sessions', spec.agent))
              : null
            try {
              assertStructuredAgentResolutionCurrent(operation)
              const args = [
                ...prefixArgs,
                ...spec.args({ fullAccess: false, pluginDir: null, model }),
                ...(folderArgs && folder ? folderArgs(folder.path) : [])
              ]
              return await runAgentModelCatalogSession<
                AcpModelCatalogSessionConnection,
                Awaited<ReturnType<typeof readSessionModels>>
              >(
                () => (deps.connectSession ?? createAcpAgentConnection)({ ...launch, args }),
                (connection, ready) =>
                  readSessionModels(
                    spec,
                    listing,
                    connection,
                    workspace,
                    operation,
                    options?.selectedModels,
                    model,
                    spec.dialect.effortChangesModel ? ready : undefined,
                    (result) =>
                      publish?.(
                        {
                          ...result,
                          models: [...result.models],
                          attemptedModels: [...result.attemptedModels],
                          origin: 'probe',
                          complete: false
                        },
                        true
                      ),
                    publish?.defer && publish.demanded
                      ? {
                          defer: (read, known) =>
                            publish.defer?.(
                              () => ({ ...read(), origin: 'probe', complete: false }),
                              known
                            ),
                          demanded: publish.demanded
                        }
                      : undefined
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
              observeAcpForkSupport(spec.agent, initialized)
              return listing.read(initialized, connection)
            },
            run
          )
        }
        if (models.length === 0) {
          throw new Error(`${spec.agent} listed no models`)
        }
        return { models, origin: 'probe' as const, ...(attemptedModels ? { attemptedModels } : {}) }
      }
    }
  }
  const probe: AgentModelCatalogProbe = async (home, options) => {
    try {
      return await (
        await resolve(home, options?.workspacePath ?? '', 'recover', options?.operation)
      ).run(options?.signal, options?.operation, options?.selectedModels, options?.publish)
    } catch (error) {
      if (error instanceof AcpAgentError && error.code === -32000) {
        throw new AgentModelCatalogUnavailableError({ reason: 'notSignedIn' })
      }
      throw error
    }
  }
  return Object.assign(probe, {
    resolve: async (...args: Parameters<typeof resolve>) => {
      const resolved = await resolve(...args)
      return {
        ...resolved,
        run: async (...runArgs: Parameters<typeof resolved.run>) => {
          try {
            return await resolved.run(...runArgs)
          } catch (error) {
            if (error instanceof AcpAgentError && error.code === -32000) {
              throw new AgentModelCatalogUnavailableError({ reason: 'notSignedIn' })
            }
            throw error
          }
        }
      }
    }
  })
}

const folderlessListing = (spec: AcpLaunchSpec) =>
  new AgentModelCatalogListingStoppedError(`${spec.agent} lists in a chat's folder`)
