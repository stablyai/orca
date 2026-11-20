// Install on the agent's chat host without a workspace; negotiate install.v1/remove.v1 and stream a snapshot followed by state revisions.

import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  ManagedRuntimeAgentParams,
  ManagedRuntimeCancelParams
} from '../../../../../shared/rpc-contract/host-management/managed-runtime-install-params'
import { ACP_LAUNCH_SPECS, acpLaunchSpecFor } from '../../../../acp/launch/acp-launch-registry'
import { resolveAcpLaunchCommand } from '../../../../acp/launch/acp-launch-command'
import { ManagedRuntimeInstallation } from '../../../../node-runtime/managed-runtime-installation'
import '../../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { isAgentSessionPreSpawnError } from '../../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { getProfileUserDataPath } from '../../../../orca-profiles/profile-storage-paths'
import { stopStructuredAgentChats } from '../../../agent-session/lifecycle/structured-agent-chat-stop'
import {
  resolveHostStructuredAgentLaunchEnvironment,
  structuredAgentHostAlternativeReady
} from '../../../agent-session/launch/structured-agent-launch-support'
import { isPathInsideOrEqual } from '../../../../../shared/file-access/cross-platform-path'
import { defineMethod, defineStreamingMethod } from '../../core'
import { delimiter, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import {
  isManagedAgentCli,
  MANAGED_AGENT_CLI_IDS,
  managedAgentCli,
  onManagedAgentUse,
  rememberManagedAgentRelease,
  type ManagedAgentCliId
} from '../../../../managed-agent-cli/managed-agent-cli-registry'
import { resolveCliCommandAsync } from '../../../../../shared/shell/command-resolution/node-cli-command-async-resolution'
import { hasExplicitTuiLaunchCommand } from '../../../../../shared/agent-launch/startup/tui-agent-launch-command-override'
import {
  isUnderWindowsDriveMount,
  readGuestWindowsDriveMountsAsync,
  withoutWindowsDriveMountDirs
} from '../../../../wsl/filesystem/wsl-guest-windows-drive-path'
import { bindStructuredAgentSessionStream } from '../structured-sessions/subscriptions/structured-agent-session-status-stream'

const installations = new Map<string, ManagedRuntimeInstallation>()

function installationFor(agent: string, runtime: OrcaRuntimeService): ManagedRuntimeInstallation {
  const existing = installations.get(agent)
  if (existing) {
    return existing
  }
  const installation = isManagedAgentCli(agent)
    ? agentCliInstallation(agent, runtime)
    : acpInstallation(agent, runtime)
  installations.set(agent, installation)
  return installation
}

function acpInstallation(agent: string, runtime: OrcaRuntimeService): ManagedRuntimeInstallation {
  const spec = acpLaunchSpecFor(agent)
  if (!spec?.managedRuntime) {
    throw new Error(`Orca installs no runtime for ${agent}.`)
  }
  const dataDirectory = getProfileUserDataPath()
  const releases = spec.managedRuntime.root(dataDirectory)
  // Use the launch's own lookup to find external runtimes.
  const findExternalCommand = async (): Promise<boolean> => {
    const settings = runtime.requireStore().getSettings()
    const env = {
      ...(await resolveHostStructuredAgentLaunchEnvironment(agent, settings)),
      ...spec.env
    }
    try {
      const { command } = resolveAcpLaunchCommand(spec, env, {
        commandSettings: settings,
        dataDirectory
      })
      return command !== spec.command && !isPathInsideOrEqual(releases, command)
    } catch (error) {
      // An unrunnable Command setting refuses start; it is not an external runtime copy.
      if (isAgentSessionPreSpawnError(error)) {
        return false
      }
      throw error
    }
  }
  // New chats start on a ready host program (e.g. the user's agy) instead, so it needs no install.
  const findExternal = async (): Promise<boolean> =>
    (await findExternalCommand()) || (await structuredAgentHostAlternativeReady(agent, runtime))
  const { launchGate } = spec
  const managedRuntime = spec.managedRuntime
  // Chats, starts, copies, sign-ins and children not proven gone all hold the gate's fence.
  const fence = (work: () => Promise<void>): Promise<void> =>
    launchGate
      ? launchGate.run(() => stopStructuredAgentChats(agent, managedRuntime.label), work)
      : Promise.reject(new Error(`${managedRuntime.label} cannot be removed on this host.`))
  // The chat host's own state root, where its launches look.
  return new ManagedRuntimeInstallation(agent, managedRuntime, {
    dataDirectory,
    findExternal,
    fence
  })
}

/** These chats run the user's own install when the host has one, so Orca's copy is the fallback. */
function agentCliInstallation(
  agent: ManagedAgentCliId,
  runtime: OrcaRuntimeService
): ManagedRuntimeInstallation {
  const managedRuntime = managedAgentCli(agent).runtime
  const dataDirectory = getProfileUserDataPath()
  // ACP agents name their own program and search their installers' folders after PATH, as launches do.
  const spec = acpLaunchSpecFor(agent)
  const findExternal = async (): Promise<boolean> => {
    const settings = runtime.requireStore().getSettings()
    if (hasExplicitTuiLaunchCommand(settings, agent)) {
      return true
    }
    const env = await resolveHostStructuredAgentLaunchEnvironment(agent, settings)
    const homePath = env.HOME ?? env.USERPROFILE
    const path = env.PATH ?? env.Path ?? null
    const dirs = spec?.installDirectories({ env, homePath: homePath ?? homedir() }) ?? []
    const searchPath =
      (dirs.length > 0 ? [path, ...dirs].filter(Boolean).join(delimiter) : path) ??
      process.env.PATH ??
      ''
    // A WSL host can't run a Windows-drive copy, so launches never find one and neither does this.
    const mounts = await readGuestWindowsDriveMountsAsync()
    const resolved = await resolveCliCommandAsync(spec?.command ?? agent, {
      pathEnv: withoutWindowsDriveMountDirs(searchPath, mounts),
      ...(homePath ? { homePath } : {})
    })
    return (
      isAbsolute(resolved) &&
      !isUnderWindowsDriveMount(resolved, mounts) &&
      !isPathInsideOrEqual(managedRuntime.root(dataDirectory), resolved)
    )
  }
  return new ManagedRuntimeInstallation(agent, managedRuntime, {
    dataDirectory,
    findExternal,
    onRelease: (release) => rememberManagedAgentRelease(agent, release),
    // No launch gate tracks these processes; stopping the agent's chats first is the closest fence.
    fence: (work) => stopStructuredAgentChats(agent, managedRuntime.label).then(work)
  })
}

/** Each installation reclaims stale releases when created, so create them every launch, not only when a client asks. */
export function reclaimManagedRuntimeReleasesAtLaunch(runtime: OrcaRuntimeService): void {
  const agents = [
    ...ACP_LAUNCH_SPECS.filter((spec) => spec.managedRuntime).map((spec) => spec.agent),
    ...MANAGED_AGENT_CLI_IDS
  ]
  for (const agent of agents) {
    try {
      installationFor(agent, runtime)
    } catch (error) {
      console.warn(`[managed-runtime] ${agent} releases not reclaimed at launch:`, error)
    }
  }
}

const AUTO_UPDATE_FIRST_CHECK_MS = 2 * 60_000
const AUTO_UPDATE_USE_THROTTLE_MS = 10 * 60_000
let autoUpdatesStarted = false
const lastUseCheck = new Map<string, number>()

function checkForUpdate(agent: string): void {
  installations
    .get(agent)
    ?.updateIfBehind()
    .catch((error: unknown) => {
      console.warn(`[managed-runtime] ${agent} update check failed:`, error)
    })
}

/** Keep Orca's own copies current without a client ever prompting: once after launch, then as they're used. */
export function startManagedRuntimeAutoUpdates(): void {
  if (autoUpdatesStarted) {
    return
  }
  autoUpdatesStarted = true
  // Wait out startup so the first check never competes with launching the app.
  setTimeout(() => {
    for (const agent of installations.keys()) {
      checkForUpdate(agent)
    }
  }, AUTO_UPDATE_FIRST_CHECK_MS).unref()
  // Use is the signal a copy matters; the release lookup itself is cached for an hour.
  onManagedAgentUse((agent) => {
    const now = Date.now()
    if (now - (lastUseCheck.get(agent) ?? 0) >= AUTO_UPDATE_USE_THROTTLE_MS) {
      lastUseCheck.set(agent, now)
      checkForUpdate(agent)
    }
  })
}

export const MANAGED_RUNTIME_INSTALL_METHODS = [
  defineStreamingMethod({
    name: 'managedRuntime.subscribe',
    permission: 'workspace',
    params: ManagedRuntimeAgentParams,
    handler: async ({ agent }, ctx, emit) => {
      const installation = installationFor(agent, ctx.runtime)
      // A failed first read fails the subscribe; a later one keeps the client's last snapshot.
      let shown = await installation.status()
      const frame = ctx.requestId ? `:${ctx.requestId}` : ''
      const subscriptionId = `managedRuntime:${ctx.connectionId ?? 'local'}:${agent}${frame}`
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      let reading = false
      let again = false
      // One read at a time; revisions during it coalesce into one more read.
      const follow = async (): Promise<void> => {
        again = true
        if (reading) {
          return
        }
        reading = true
        try {
          while (again && !stream.isClosed()) {
            again = false
            const next = await installation.status(false)
            if (next.revision !== shown.revision && !stream.isClosed()) {
              shown = next
              emit(next)
            }
          }
        } catch (error) {
          console.warn(`[managed-runtime] ${agent} status not read for a subscriber:`, error)
        } finally {
          reading = false
        }
      }
      dispose = installation.subscribe(() => void follow())
      emit(shown)
      // Catches a revision between the first read and the subscribe.
      void follow()
    }
  }),
  defineMethod({
    name: 'managedRuntime.install',
    permission: 'host-admin',
    params: ManagedRuntimeAgentParams,
    handler: async ({ agent }, { runtime }) => {
      const installation = installationFor(agent, runtime)
      installation.install()
      return installation.status()
    }
  }),
  defineMethod({
    name: 'managedRuntime.cancel',
    permission: 'host-admin',
    params: ManagedRuntimeCancelParams,
    handler: async ({ agent, operationId }, { runtime }) => {
      // The outcome once the run has unwound: `cancelled`, or `succeeded` if it had committed.
      return await installationFor(agent, runtime).cancel(operationId)
    }
  }),
  defineMethod({
    name: 'managedRuntime.remove',
    permission: 'host-admin',
    params: ManagedRuntimeAgentParams,
    handler: async ({ agent }, { runtime }) => {
      const installation = installationFor(agent, runtime)
      installation.remove()
      return installation.status()
    }
  })
] as const
