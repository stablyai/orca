import { observeAcpForkSupport } from '../capabilities/acp-fork-support'
import { join } from 'node:path'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import {
  AtRestCommandCatalog,
  type AtRestCommandScan
} from '../../native-chat/agent-session-wire/options/at-rest-command-catalog'
import { resolveNativeChatVisualsSkillLocation } from '../../native-chat/conversation-files/native-chat-visuals-skill-location'
import type { StructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import type { AgentCliVersionReader } from '../../agent-launch/preflight/agent-cli-version-probe'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../../shared/agent-session/lifecycle/agent-session-caller-env'
import { ORCA_AGENT_SESSION_CALLER_ENV_KEYS } from '../../ipc/pty/host-env/spawn-env-keys'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../../runtime/agent-session/environment/structured-session-child-env'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV
} from '../../native-chat/conversation-files/native-chat-visuals-delivery'
import { acpListingDependsOnRelease, acpModelListingForRelease } from './acp-model-discovery-policy'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { createAcpAgentConnection } from '../process/acp-agent-connection'
import { acpRunFolder } from '../launch/acp-private-temp'
import { supportsAcpStructuredLocation } from '../session/acp-structured-location-support'
import { checkAcpLaunchVersion } from '../launch/acp-launch-version'
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
  connect?: (launch: ProviderProcessLaunch) => AcpDiscoveryConnection
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
        let answer: (value: AtRestCommandScan) => void = () => {}
        let fail: (reason: unknown) => void = () => {}
        const result = new Promise<AtRestCommandScan>((resolve, reject) => {
          answer = resolve
          fail = reject
        })
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
          try {
            check()
            const invocation = await awaitAcpDiscovery(
              resolveAcpLaunchInvocation(spec, record.accountHome, {
                ...deps,
                resolveWorkingDirectory: () => cwd
              }),
              signal
            )
            check()
            const activeSpec = invocation.spec
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
              activeSpec,
              launch,
              acpListingDependsOnRelease(activeSpec.modelDiscovery),
              deps.probeVersion
            )
            check()
            if (version.status === 'tooOld') {
              throw new Error('ACP command discovery unavailable')
            }
            const listing = acpModelListingForRelease(activeSpec.modelDiscovery, version.version)
            // Releases that list without a session (OpenCode 1.x) report commands only in chats.
            if (listing?.kind !== 'session') {
              answer({ commands: undefined, fromAgent: false })
              return
            }
            const location = activeSpec.visualsSkill
              ? await awaitAcpDiscovery(
                  (deps.resolveVisualsSkill ?? resolveNativeChatVisualsSkillLocation)(),
                  signal
                )
              : null
            check()
            const skill =
              location && activeSpec.visualsSkill
                ? await awaitAcpDiscovery(
                    activeSpec.visualsSkill({
                      skill: location,
                      version: version.version,
                      env: launch.env
                    }),
                    signal
                  )
                : null
            check()
            let folderArgs: string[] = []
            if (listing.sessionFolderArgs) {
              folder = await acpRunFolder(
                join(deps.dataDirectory, 'acp-command-sessions', activeSpec.agent),
                deps.logger
              )
              folderArgs = listing.sessionFolderArgs(folder.path)
              check()
            }
            const connection = (deps.connect ?? createAcpAgentConnection)({
              ...launch,
              env: { ...launch.env, ...skill?.env },
              args: [
                ...invocation.prefixArgs,
                ...activeSpec.args({ fullAccess: false, pluginDir: skill?.pluginDir ?? null }),
                ...folderArgs
              ]
            })
            owned = connection
            unclosed.add(connection)
            const discovery = runAcpSessionDiscovery(connection, signal, (checkSession) =>
              readAcpSessionCommands({
                connection,
                dialect: activeSpec.dialect,
                onInitialize: (initialized) => observeAcpForkSupport(activeSpec.agent, initialized),
                cwd,
                signal,
                check: () => {
                  checkSession()
                  check()
                },
                disposableStorage: folder !== undefined,
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
                const cleanup = Promise.resolve(folder?.remove()).finally(() => {
                  retainedRelease()
                  completions.delete(cleanup)
                })
                completions.add(cleanup)
              })
              return
            }
            unclosed.delete(connection)
            await folder?.remove()
            folder = undefined
          } finally {
            if (!owned) {
              await folder?.remove()
            }
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
