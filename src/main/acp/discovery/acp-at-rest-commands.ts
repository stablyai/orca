import { observeAcpForkSupport } from '../capabilities/acp-fork-support'
import { join } from 'node:path'
import { PrioritySemaphore } from '../../../shared/concurrency/priority-semaphore'
import {
  AtRestCommandCatalog,
  type AtRestCommandScan
} from '../../native-chat/agent-session-wire/options/at-rest-command-catalog'
import { resolveNativeChatVisualsSkillLocation } from '../../native-chat/conversation-files/native-chat-visuals-skill-location'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { AgentCliVersionReader } from '../../agent-launch/preflight/agent-cli-version-probe'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { ORCA_AGENT_SESSION_CALLER_ENV_KEYS } from '../../ipc/pty/host-env/spawn-env-keys'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../../runtime/agent-session/environment/structured-session-child-env'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV
} from '../../native-chat/conversation-files/native-chat-visuals-delivery'
import { acpListingDependsOnRelease, acpModelListingForRelease } from './acp-model-discovery-policy'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import {
  createAcpAgentConnection,
  type AcpAgentConnectionOptions
} from '../process/acp-agent-connection'
import { acpClientInfo } from '../launch/acp-client-info'
import { acpRunFolder } from '../launch/acp-private-temp'
import { enterAcpListingAccount } from './acp-listing-account'
import { acpListingSessionDiscard } from './acp-listing-session-discard'
import { supportsAcpStructuredLocation } from '../session/acp-structured-location-support'
import { checkAcpLaunchVersion } from '../launch/acp-launch-version'
import { acpChatHomeNow } from '../launch/acp-launch-home-before-first-turn'
import {
  resolveAcpLaunchInvocation,
  type AcpLaunchInvocationDeps
} from '../launch/acp-structured-launch-resolution'
import {
  awaitAcpDiscovery,
  readAcpSessionCommands,
  runAcpSessionDiscovery,
  type AcpDiscoveryConnection
} from './acp-session-discovery'

export type AcpAtRestCommandDeps = AcpLaunchInvocationDeps & {
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  probeVersion?: AgentCliVersionReader
  connect?: (
    launch: ProviderProcessLaunch,
    options: AcpAgentConnectionOptions
  ) => AcpDiscoveryConnection
  resolveVisualsSkill?: typeof resolveNativeChatVisualsSkillLocation
  logger?: StructuredAgentSessionLogger
  isWindowsProcessStartTimeAvailable?: () => boolean
}

export class AcpAtRestCommandCatalog extends AtRestCommandCatalog {
  private readonly drain: () => Promise<void>

  constructor(spec: AcpLaunchSpec, deps: AcpAtRestCommandDeps) {
    const admission = new PrioritySemaphore(2)
    const lifetime = new AbortController()
    const completions = new Set<Promise<void>>()
    const unclosed = new Set<AcpDiscoveryConnection>()
    let admitted = 0
    super({
      label: `${spec.agent}-commands`,
      scanTimeoutMs: 9_000,
      maxFailedScans: null,
      evictUnreadMs: null,
      missingWorkspaceIsFailure: true,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      accepts: (record) =>
        record.provider === spec.agent &&
        supportsAcpStructuredLocation(
          spec,
          record.location,
          deps.isWindowsProcessStartTimeAvailable
        ),
      scan: (record, cwd, isCurrent, _generation, contextSignal, _admitted, demand) => {
        const signal = AbortSignal.any([lifetime.signal, contextSignal])
        const {
          promise: result,
          resolve: answer,
          reject: fail
        } = Promise.withResolvers<AtRestCommandScan>()
        const check = () => {
          signal.throwIfAborted()
          if (!isCurrent()) {
            throw new Error('ACP command context retired')
          }
        }
        const run = async () => {
          check()
          if (!demand.independent && admitted >= 34) {
            throw new Error('ACP command discovery busy')
          }
          let countedLegacy = !demand.independent
          if (countedLegacy) {
            admitted++
          }
          let release: () => void
          try {
            release = await demand.acquire(admission, signal)
            if (countedLegacy && demand.independent) {
              admitted--
              countedLegacy = false
            }
          } catch (error) {
            if (countedLegacy) {
              admitted--
            }
            throw error
          }
          const releasePermit = release
          release = () => {
            if (countedLegacy) {
              admitted--
            }
            releasePermit()
          }
          let folder: Awaited<ReturnType<typeof acpRunFolder>> | undefined
          let owned: AcpDiscoveryConnection | undefined
          let gate: Awaited<ReturnType<typeof enterAcpListingAccount>> | undefined
          // Sessions an agent without ACP delete keeps; removed once its process has exited.
          const started: string[] = []
          let discardSessions: ReturnType<typeof acpListingSessionDiscard> = null
          const removeScratch = async (): Promise<void> => {
            await discardSessions?.(started.splice(0))
            await folder?.remove()
          }
          try {
            check()
            // A chat before its first message starts on the sign-in method picked since.
            const accountHome = await awaitAcpDiscovery(acpChatHomeNow(spec, record, deps), signal)
            const invocation = await awaitAcpDiscovery(
              resolveAcpLaunchInvocation(spec, accountHome, {
                ...deps,
                resolveWorkingDirectory: () => cwd
              }),
              signal
            )
            check()
            // The account picks the spec: agy on a home Orca owns needs that home's own args.
            const launchSpec = invocation.spec
            const launch = {
              ...invocation,
              cwd,
              env: { ...invocation.env },
              envToDelete: [
                ...invocation.envToDelete,
                ...STRUCTURED_CHILD_ENV_TO_DELETE,
                ...ORCA_AGENT_SESSION_CALLER_ENV_KEYS,
                ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV,
                NATIVE_CHAT_SCRATCH_DIR_ENV,
                LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
              ]
            }
            // A version reader owns work too; retain admission until it drains after cancellation.
            const version = await checkAcpLaunchVersion(
              launchSpec,
              launch,
              acpListingDependsOnRelease(launchSpec.modelDiscovery),
              deps.probeVersion
            )
            check()
            if (version.status === 'tooOld') {
              throw new Error('ACP command discovery unavailable')
            }
            const listing = acpModelListingForRelease(launchSpec.modelDiscovery, version.version)
            // Releases that list without a session (OpenCode 1.x) report commands only in chats.
            if (listing?.kind !== 'session') {
              answer({ commands: undefined, fromAgent: false })
              return
            }
            const location = launchSpec.skillRoots
              ? await awaitAcpDiscovery(
                  (deps.resolveVisualsSkill ?? resolveNativeChatVisualsSkillLocation)(),
                  signal
                )
              : null
            check()
            const skill =
              location && launchSpec.skillRoots
                ? await awaitAcpDiscovery(
                    launchSpec.skillRoots({
                      roots: [location],
                      version: version.version,
                      env: launch.env
                    }),
                    signal
                  )
                : null
            check()
            // Like a model listing: no scan while the sign-in method changes, and the files a
            // start writes for the method saved now.
            const auth = invocation.antigravityChatAuth
            gate = await enterAcpListingAccount(launchSpec, launch.env, auth, signal, check)
            const gated = gate.signal
            discardSessions = acpListingSessionDiscard(
              spec.agent,
              listing,
              accountHome,
              cwd,
              launch
            )
            let folderArgs: string[] = []
            if (listing.sessionFolderArgs) {
              folder = await acpRunFolder(
                join(deps.dataDirectory, 'acp-command-sessions', spec.agent),
                deps.logger
              )
              folderArgs = listing.sessionFolderArgs(folder.path)
              check()
            }
            const connection = gate.retain(
              (deps.connect ?? createAcpAgentConnection)(
                {
                  ...launch,
                  env: { ...launch.env, ...skill?.env },
                  args: [
                    ...invocation.prefixArgs,
                    ...launchSpec.args({ fullAccess: false, pluginDirs: skill?.pluginDirs ?? [] }),
                    ...(skill?.args ?? []),
                    ...folderArgs
                  ]
                },
                { clientInfo: acpClientInfo(launchSpec) }
              )
            )
            owned = connection
            unclosed.add(connection)
            const discovery = runAcpSessionDiscovery(connection, gated, (checkSession) =>
              readAcpSessionCommands({
                connection,
                dialect: launchSpec.dialect,
                onInitialize: (initialized) => observeAcpForkSupport(spec.agent, initialized),
                cwd,
                signal: gated,
                check: () => {
                  checkSession()
                  check()
                },
                disposableStorage: folder !== undefined || discardSessions !== null,
                onSession: (sessionId) => started.push(sessionId),
                logger: deps.logger
              })
            )
            discovery.answer.then(answer, fail)
            const evidence = await discovery.completion
            const close = evidence.result
            if (evidence.error || close?.root !== 'exited' || close.tree !== 'exited') {
              deps.logger?.warn('ACP command discovery close evidence', {
                scope: 'acp-command-discovery',
                result: close,
                error: evidence.error
              })
            }
            // Managed root completion ends this disposable owner; tree findings stay diagnostic.
            if (connection.rootVerdict !== 'exited') {
              const retainedRelease = release
              release = () => {}
              connection.onExit(() => {
                if (connection.rootVerdict !== 'exited' || !unclosed.delete(connection)) {
                  return
                }
                const cleanup = removeScratch().finally(() => {
                  retainedRelease()
                  completions.delete(cleanup)
                })
                completions.add(cleanup)
              })
              return
            }
            unclosed.delete(connection)
            await removeScratch()
            folder = undefined
          } finally {
            if (!owned) {
              await folder?.remove()
            }
            gate?.leave()
            release()
          }
        }
        const completion = run()
          .catch(fail)
          .finally(() => completions.delete(completion))
        completions.add(completion)
        return result
      }
    })
    const disposeCatalog = this.dispose
    this.dispose = () => {
      lifetime.abort(new Error('ACP command discovery stopped'))
      disposeCatalog()
    }
    this.drain = async () => {
      while (completions.size) {
        await Promise.all(completions)
      }
      if (unclosed.size) {
        throw new Error('ACP command discovery could not prove its owners stopped')
      }
    }
  }

  async closeAll(): Promise<void> {
    this.dispose()
    await this.drain()
  }
}
