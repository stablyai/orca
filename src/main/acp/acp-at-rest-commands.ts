import { join } from 'node:path'
import { PrioritySemaphore } from '../../shared/priority-semaphore'
import { isLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import {
  AtRestCommandCatalog,
  type AtRestCommandScan
} from '../native-chat/agent-session-wire/at-rest-command-catalog'
import { resolveNativeChatVisualsSkillLocation } from '../native-chat/native-chat-visuals-skill-location'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import type { AgentCliVersionReader } from '../agent-cli-version-probe'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../shared/agent-session-caller-env'
import { ORCA_AGENT_SESSION_CALLER_ENV_KEYS } from '../ipc/pty/host-env/spawn-env-keys'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/structured-session-child-env'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV
} from '../native-chat/native-chat-visuals-delivery'
import type { AcpLaunchSpec } from './acp-launch-specs'
import { createAcpAgentConnection } from './acp-agent-connection'
import { acpRunFolder } from './acp-private-temp'
import { supportsAcpStructuredLocation } from './acp-structured-location-support'
import { AcpStructuredOptions } from './acp-structured-options'
import {
  checkAcpLaunchVersion,
  resolveAcpLaunchInvocation,
  type AcpLaunchInvocationDeps
} from './acp-structured-launch-resolution'
import {
  awaitAcpDiscovery,
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
        spec.agent === 'omp' &&
        isLegacyAgentSessionAccountHome(record.accountHome) &&
        supportsAcpStructuredLocation(
          spec,
          record.location,
          deps.isWindowsProcessStartTimeAvailable
        ),
      scan: (record, cwd, isCurrent, _generation, contextSignal) => {
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
          if (admitted >= 34) {
            throw new Error('ACP command discovery busy')
          }
          admitted++
          let release: () => void
          try {
            release = await admission.acquire(0, signal)
          } catch (error) {
            admitted--
            throw error
          }
          const releasePermit = release
          release = () => {
            admitted--
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
            const launch = {
              ...invocation,
              cwd,
              env: { ...invocation.env },
              envToDelete: [
                ...invocation.envToDelete,
                ...STRUCTURED_CHILD_ENV_TO_DELETE,
                ...ORCA_AGENT_SESSION_CALLER_ENV_KEYS,
                ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV,
                'ORCA_TERMINAL_HANDLE',
                NATIVE_CHAT_SCRATCH_DIR_ENV,
                LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
              ]
            }
            // A version reader owns work too; retain admission until it drains after cancellation.
            const version = await checkAcpLaunchVersion(spec, launch, false, deps.probeVersion)
            check()
            if (version.status === 'tooOld') {
              throw new Error('ACP command discovery unavailable')
            }
            const location = spec.visualsSkill
              ? await awaitAcpDiscovery(
                  (deps.resolveVisualsSkill ?? resolveNativeChatVisualsSkillLocation)(),
                  signal
                )
              : null
            check()
            const skill =
              location && spec.visualsSkill
                ? await awaitAcpDiscovery(
                    spec.visualsSkill({
                      skill: location,
                      version: version.version,
                      env: launch.env
                    }),
                    signal
                  )
                : null
            check()
            const listing = spec.modelDiscovery
            if (listing.kind !== 'session' || !listing.sessionFolderArgs) {
              throw new Error('ACP disposable command session unavailable')
            }
            folder = await acpRunFolder(
              join(deps.dataDirectory, 'acp-command-sessions', spec.agent),
              deps.logger
            )
            check()
            const connection = (deps.connect ?? createAcpAgentConnection)({
              ...launch,
              env: { ...launch.env, ...skill?.env },
              args: [
                ...spec.args({ fullAccess: false, pluginDir: skill?.pluginDir ?? null }),
                ...listing.sessionFolderArgs(folder.path)
              ]
            })
            owned = connection
            unclosed.add(connection)
            const discovery = runAcpSessionDiscovery(connection, signal, async (checkSession) => {
              const options = new AcpStructuredOptions(spec.dialect)
              let nativeId: string | undefined
              let provisional:
                | {
                    sessionId: string
                    commands: Parameters<AcpStructuredOptions['adoptCommands']>[0]
                  }
                | undefined
              let reported: () => void = () => {}
              const ready = new Promise<void>((resolve) => {
                reported = resolve
              })
              const unsubscribe = connection.subscribe((event) => {
                if (
                  signal.aborted ||
                  event.kind !== 'known' ||
                  event.notification.update.sessionUpdate !== 'available_commands_update'
                ) {
                  return
                }
                const { sessionId, update } = event.notification
                if (nativeId !== undefined && sessionId !== nativeId) {
                  return
                }
                provisional = { sessionId, commands: update.availableCommands }
                if (nativeId !== undefined) {
                  options.adoptCommands(update.availableCommands)
                  reported()
                }
              })
              try {
                await awaitAcpDiscovery(connection.initialize(), signal)
                checkSession()
                check()
                const started = await awaitAcpDiscovery(
                  connection.start({ cwd, mcpServers: [] }),
                  signal
                )
                checkSession()
                check()
                nativeId = started.sessionId
                if (provisional?.sessionId === nativeId) {
                  options.adoptCommands(provisional.commands)
                  reported()
                }
                await awaitAcpDiscovery(ready, signal)
                checkSession()
                check()
                return { commands: options.readCommands(), fromAgent: true }
              } finally {
                unsubscribe()
              }
            })
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
                const cleanup = folder!.remove().finally(() => {
                  retainedRelease()
                  completions.delete(cleanup)
                })
                completions.add(cleanup)
              })
              return
            }
            unclosed.delete(connection)
            await folder.remove()
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
