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
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import type { ProviderAcquisitionConnection } from '../../provider-process/provider-acquisition-starts'
import { enterAcpListingGate } from './acp-listing-launch-gate'
import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import {
  createAcpAgentConnection,
  type AcpAgentConnectionOptions
} from '../process/acp-agent-connection'
import { acpClientInfo } from '../launch/acp-client-info'
import { acpRunFolder } from '../launch/acp-private-temp'
import { acpListingDependsOnRelease, acpModelListingForRelease } from './acp-model-discovery-policy'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { checkAcpLaunchVersion } from '../launch/acp-launch-version'
import { prepareAcpListingAccount } from './acp-listing-account'
import { acpLaunchSpecForAccount } from '../launch/acp-launch-command'
import { agentSessionAccountHomePath } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import {
  resolveAcpLaunchInvocation,
  type AcpLaunchInvocationDeps
} from '../launch/acp-structured-launch-resolution'
import {
  readSessionModels,
  type AcpModelCatalogConnection,
  type AcpModelCatalogSessionConnection
} from './acp-listing-session-models'
import { AcpAgentExitedError } from '../transport/acp-errors'
import { signedOutAsUnavailable } from './acp-listing-signed-out'
import { discardAcpListingSessions } from './acp-listing-session-discard'
import { sealSharedToolProcessChild } from '../../runtime/agent-session/environment/structured-session-child-env'
import { usesModelSpecificAcpEfforts } from '../../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'

type AcpListingConnect<C> = (
  launch: ProviderProcessLaunch,
  options: AcpAgentConnectionOptions
) => C & ProviderAcquisitionConnection

export type AcpModelCatalogProbeDeps = AcpLaunchInvocationDeps & {
  resolveSavedEnvironment?: () => Promise<Record<string, string>>
  probeVersion?: AgentCliVersionReader
  connect?: AcpListingConnect<AcpModelCatalogConnection>
  connectSession?: AcpListingConnect<AcpModelCatalogSessionConnection>
  runListing?: typeof runAgentModelCatalogListing
}

/** Uses the same binary, account and scrubbed environment as chats. */
export function createAcpModelCatalogProbe(
  agentSpec: AcpLaunchSpec,
  deps: AcpModelCatalogProbeDeps
): AgentModelCatalogProbe {
  const resolve = async (
    accountHome: Parameters<AgentModelCatalogProbe>[0],
    workspace: string,
    lookup: AgentModelCatalogLookup = 'recover',
    operation?: StructuredAgentResolutionOperation
  ) => {
    assertStructuredAgentResolutionCurrent(operation)
    // A host install can list differently from Orca's managed one, so the account picks the spec.
    const spec = acpLaunchSpecForAccount(agentSpec, accountHome)
    const discovery = spec.modelDiscovery
    if (discovery.kind === 'unavailable') {
      throw new Error(discovery.reason)
    }
    // Start in home; only explicit chat-folder discovery reads project config.
    const cwd = deps.homePath ?? homedir()
    const { command, prefixArgs, env, envToDelete, version, antigravityChatAuth } =
      await resolveAcpLaunchInvocation(spec, accountHome, {
        ...deps,
        ...(lookup !== 'recover'
          ? {
              resolveEnvironment: deps.resolveSavedEnvironment ?? deps.resolveEnvironment,
              refreshEnvironmentAfterMiss: undefined
            }
          : {}),
        operation,
        resolveWorkingDirectory: () => cwd
      })
    assertStructuredAgentResolutionCurrent(operation)
    return {
      answerSignIn: spec.signIn?.answered,
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
        const gate = enterAcpListingGate(spec.launchGate, options.signal)
        let models: AgentSessionModelOption[]
        let attemptedModels: string[] | undefined
        try {
          await prepareAcpListingAccount(spec, env, antigravityChatAuth, () =>
            assertStructuredAgentResolutionCurrent(operation)
          )
          const launch = {
            command,
            args: [...prefixArgs, ...spec.args({ fullAccess: false, pluginDirs: [] })],
            cwd,
            // A shared tool process started by this listing keeps its environment for later chats.
            ...(spec.sharedToolProcess
              ? sealSharedToolProcessChild(env, envToDelete)
              : { env, envToDelete })
          }
          // Chats send this identity, and some servers list models only to clients they allowlist.
          const connectionOptions = { clientInfo: acpClientInfo(spec, version ?? release.version) }
          const run = { label: spec.agent, signal: gate.signal, timeoutMs: null }
          // OMP records every model switch as account usage; starting on the picked model records none.
          const launchedModel =
            spec.launchesWithModel && usesModelSpecificAcpEfforts(spec.agent)
              ? options?.selectedModels?.[0]
              : undefined
          if (listing.kind === 'command') {
            const stdout = await (deps.runListing ?? runAgentModelCatalogListing)(
              {
                command,
                args: [...prefixArgs, ...listing.args],
                cwd: workspace || cwd,
                env,
                envToDelete
              },
              { site: `${spec.agent}-model-catalog-probe`, signal: gate.signal, timeoutMs: null }
            )
            models = listing.parse(stdout)
          } else if (listing.kind === 'session') {
            // Remove disposable session storage after the process closes.
            const folderArgs = listing.sessionFolderArgs
            // Without a chat's folder, the account's models list in an empty private one.
            const inPrivateFolder = listing.inPrivateFolder || !workspace
            const listInSession = async (model: string | undefined) => {
              const folder =
                folderArgs || inPrivateFolder
                  ? await acpRunFolder(join(deps.dataDirectory, 'acp-listing-sessions', spec.agent))
                  : null
              const sessionCwd = inPrivateFolder && folder ? folder.path : workspace
              const started: string[] = []
              try {
                assertStructuredAgentResolutionCurrent(operation)
                const args = [
                  ...prefixArgs,
                  ...spec.args({ fullAccess: false, pluginDirs: [], model }),
                  ...(folderArgs && folder ? folderArgs(folder.path) : [])
                ]
                return await runAgentModelCatalogSession<
                  AcpModelCatalogSessionConnection,
                  Awaited<ReturnType<typeof readSessionModels>>
                >(
                  () =>
                    gate.retain(
                      (deps.connectSession ?? createAcpAgentConnection)(
                        { ...launch, args },
                        connectionOptions
                      )
                    ),
                  (connection, ready) =>
                    readSessionModels(
                      spec,
                      listing,
                      connection,
                      sessionCwd,
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
                        : undefined,
                      (sessionId) => started.push(sessionId)
                    ),
                  run
                )
              } finally {
                const accountHomePath = agentSessionAccountHomePath(accountHome)
                if (accountHomePath) {
                  await discardAcpListingSessions(spec.agent, listing, started, {
                    cwd: sessionCwd,
                    accountHomePath,
                    // Unbounded by the listing's signal: a cancelled listing still discards its session.
                    runAgent: (agentArgs) =>
                      (deps.runListing ?? runAgentModelCatalogListing)(
                        { ...launch, args: [...prefixArgs, ...agentArgs] },
                        { site: `${spec.agent}-listing-discard` }
                      )
                  })
                }
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
              () =>
                gate.retain((deps.connect ?? createAcpAgentConnection)(launch, connectionOptions)),
              async (connection) => {
                const initialized = await connection.initialize()
                assertStructuredAgentResolutionCurrent(operation)
                observeAcpForkSupport(spec.agent, initialized)
                return listing.read(initialized, connection)
              },
              run
            )
          }
        } catch (error) {
          throw gate.stopped(error)
        } finally {
          gate.leave()
        }
        if (models.length === 0) {
          throw new Error(`${spec.agent} listed no models`)
        }
        const fastModeSupport = models.some((model) => model.supportsFastMode === true)
          ? { supported: true as const }
          : undefined
        return {
          models,
          origin: 'probe' as const,
          ...(fastModeSupport ? { fastModeSupport } : {}),
          ...(attemptedModels ? { attemptedModels } : {})
        }
      }
    }
  }
  const probe: AgentModelCatalogProbe = (home, options) =>
    resolve(home, options?.workspacePath ?? '', 'recover', options?.operation).then((resolved) =>
      resolved
        .run(options?.signal, options?.operation, options?.selectedModels, options?.publish)
        .catch(signedOutAsUnavailable(agentSpec.dialect, resolved.answerSignIn))
    )
  return Object.assign(probe, {
    resolve: async (...args: Parameters<typeof resolve>) => {
      const { answerSignIn, ...resolved } = await resolve(...args)
      return {
        ...resolved,
        run: (...runArgs: Parameters<typeof resolved.run>) =>
          resolved.run(...runArgs).catch(signedOutAsUnavailable(agentSpec.dialect, answerSignIn))
      }
    }
  })
}
