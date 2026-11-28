// Install on the agent's chat host without a workspace; negotiate install.v1/remove.v1 and stream a snapshot followed by state revisions.

import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  ManagedRuntimeAgentParams,
  ManagedRuntimeCancelParams
} from '../../../../../shared/rpc-contract/host-management/managed-runtime-install-params'
import { ACP_LAUNCH_SPECS, acpLaunchSpecFor } from '../../../../acp/launch/acp-launch-registry'
import type { ManagedCopySettings } from '../../../../acp/launch/acp-launch-contract'
import { findHostProgram, resolveAcpLaunchCommand } from '../../../../acp/launch/acp-launch-command'
import type { ManagedRuntimeProgram } from '../../../../../shared/agent-launch/installation/managed-runtime-install'
import { ManagedRuntimeInstallation } from '../../../../node-runtime/managed-runtime-installation'
import { onManagedServerUse } from '../../../../node-runtime/managed-runtime-release'
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
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  isManagedAgentCli,
  MANAGED_AGENT_CLI_IDS,
  managedAgentCli,
  onManagedAgentUse,
  rememberManagedAgentRelease,
  type ManagedAgentCliId
} from '../../../../managed-agent-cli/managed-agent-cli-registry'
import { createRevisionClock, type RevisionClock } from '../../../events/revisioned-state'
import { streamManagedRuntimeInstall } from './managed-runtime-install-stream'
import { noteManagedReleasesRead, provideManagedAgentDetection } from './managed-copy-detection'
import { hasExplicitTuiLaunchCommand } from '../../../../../shared/agent-launch/startup/tui-agent-launch-command-override'
import { agentSessionInstallCommand } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { removeTree } from '../../../../../shared/file-write/windows-transient-lock-removal'

const installations = new Map<string, ManagedRuntimeInstallation>()
const revisionClocks = new Map<string, RevisionClock>()

/** What Orca keeps for `agent`: its ACP launch's own server, its copy of the CLI, or both. */
function installationPrograms(agent: string): ManagedRuntimeProgram[] {
  const kinds: ManagedRuntimeProgram[] = []
  if (acpLaunchSpecFor(agent)?.managedRuntime || !isManagedAgentCli(agent)) {
    kinds.push('server')
  }
  if (isManagedAgentCli(agent)) {
    kinds.push('cli')
  }
  return kinds
}

function installationOf(
  agent: string,
  program: ManagedRuntimeProgram,
  runtime: OrcaRuntimeService
): ManagedRuntimeInstallation {
  const key = `${program}:${agent}`
  const existing = installations.get(key)
  if (existing) {
    return existing
  }
  const revisions = revisionClockFor(agent)
  const installation =
    program === 'cli' && isManagedAgentCli(agent)
      ? agentCliInstallation(agent, runtime, revisions)
      : acpInstallation(agent, runtime, revisions)
  installations.set(key, installation)
  return installation
}

function revisionClockFor(agent: string): RevisionClock {
  const clock = revisionClocks.get(agent) ?? createRevisionClock()
  revisionClocks.set(agent, clock)
  return clock
}

/** The installation `program` names, or the one Install, its status and removal act on. */
function selectedInstallation(
  agent: string,
  runtime: OrcaRuntimeService,
  program?: ManagedRuntimeProgram
): ManagedRuntimeInstallation {
  const programs = installationPrograms(agent)
  if (program && programs.includes(program)) {
    return installationOf(agent, program, runtime)
  }
  return installationOf(agent, programs.includes('cli') ? 'cli' : 'server', runtime)
}

// An older client may still offer Install for agy, which Orca no longer downloads.
function noRuntimeError(agent: string): Error {
  const command = agent === 'antigravity' && agentSessionInstallCommand(agent, process.platform)
  return new Error(
    command
      ? `Orca no longer installs agy. Install it with: ${command}`
      : `Orca installs no runtime for ${agent}.`
  )
}

function acpInstallation(
  agent: string,
  runtime: OrcaRuntimeService,
  revisions: RevisionClock
): ManagedRuntimeInstallation {
  const spec = acpLaunchSpecFor(agent)
  if (!spec?.managedRuntime) {
    throw noRuntimeError(agent)
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
  // New chats start on a ready host program instead, so it needs no install.
  const findExternal = async (): Promise<boolean> =>
    (await findExternalCommand()) || (await structuredAgentHostAlternativeReady(agent, runtime))
  const { launchGate } = spec
  const managedRuntime = spec.managedRuntime
  // Chats, starts, copies, sign-ins and children not proven gone all hold the gate's fence.
  const fence = (work: () => Promise<void>): Promise<void> =>
    launchGate
      ? launchGate.run(() => stopStructuredAgentChats(agent, managedRuntime.label), work)
      : Promise.reject(new Error(`${managedRuntime.label} cannot be removed on this host.`))
  // The chat host's own state root, where its launches look. Its kill switch is this host's own
  // setting, read when used: the store may not exist yet when this installation is created.
  const updatesAllowed = (settings: ManagedCopySettings) =>
    spec.managedRuntimeUpdatesAllowed?.(settings) !== false
  return new ManagedRuntimeInstallation(agent, managedRuntime, {
    dataDirectory,
    program: 'server',
    findExternal,
    updatesEnabled: () => updatesAllowed(runtime.requireStore().getSettings()),
    // Turned off while an automatic update downloads, it stops instead of finishing. Only changes the
    // store publishes reach this; a hand edit of the settings file applies at the next check.
    watchUpdatesEnabled: (onDisabled) =>
      runtime.requireStore().onSettingsChanged?.((_updates, settings) => {
        if (!updatesAllowed(settings)) {
          onDisabled()
        }
      }) ?? (() => undefined),
    fence,
    revisions
  })
}

/** These chats run the user's own install when the host has one, so Orca's copy is the fallback. */
function agentCliInstallation(
  agent: ManagedAgentCliId,
  runtime: OrcaRuntimeService,
  revisions: RevisionClock
): ManagedRuntimeInstallation {
  const managedRuntime = managedAgentCli(agent).runtime
  const dataDirectory = getProfileUserDataPath()
  const spec = acpLaunchSpecFor(agent)
  const findExternal = async (): Promise<boolean> => {
    const settings = runtime.requireStore().getSettings()
    if (!spec?.ignoreAgentCommandSetting && hasExplicitTuiLaunchCommand(settings, agent)) {
      return true
    }
    const env = await resolveHostStructuredAgentLaunchEnvironment(agent, settings)
    const homePath = env.HOME ?? env.USERPROFILE ?? homedir()
    const dirs = spec?.installDirectories({ env, homePath }) ?? []
    const found = await findHostProgram(spec?.command ?? agent, env, dirs)
    return found !== null && !isPathInsideOrEqual(managedRuntime.root(dataDirectory), found)
  }
  return new ManagedRuntimeInstallation(agent, managedRuntime, {
    dataDirectory,
    program: 'cli',
    findExternal,
    hostHasBuild: () => managedAgentCli(agent).available(),
    onRelease: (folder) => rememberManagedAgentRelease(agent, folder),
    // No launch gate tracks these processes; stopping the agent's chats first is the closest fence.
    fence: (work) => stopStructuredAgentChats(agent, managedRuntime.label).then(work),
    revisions
  })
}

/** Each installation reclaims stale releases when created, so create them every launch, not only when a client asks. */
export function reclaimManagedRuntimeReleasesAtLaunch(runtime: OrcaRuntimeService): void {
  provideManagedAgentDetection()
  void removeRetiredAgyCopies(getProfileUserDataPath())
  const agents = new Set([
    ...ACP_LAUNCH_SPECS.filter((spec) => spec.managedRuntime).map((spec) => spec.agent),
    ...MANAGED_AGENT_CLI_IDS
  ])
  for (const agent of agents) {
    for (const program of installationPrograms(agent)) {
      try {
        installationOf(agent, program, runtime)
      } catch (error) {
        console.warn(`[managed-runtime] ${agent} releases not reclaimed at launch:`, error)
      }
    }
  }
  noteManagedReleasesRead()
}

/** Orca's own agy and its retired ACP server; a file Windows still holds open goes next launch. */
async function removeRetiredAgyCopies(dataDirectory: string): Promise<void> {
  for (const name of ['agy', 'antigravity']) {
    await removeTree(join(dataDirectory, 'agent-runtimes', name)).catch((error: unknown) => {
      console.warn(`[managed-runtime] Orca's old ${name} copy not removed yet:`, error)
    })
  }
}

const AUTO_UPDATE_FIRST_CHECK_MS = 2 * 60_000
const AUTO_UPDATE_USE_THROTTLE_MS = 10 * 60_000
let autoUpdatesStarted = false
const lastUseCheck = new Map<string, number>()

/** Use is the signal a copy matters; the installation's own backoff decides whether it downloads. */
function checkForUpdateOnUse(key: string): void {
  const now = Date.now()
  if (now - (lastUseCheck.get(key) ?? 0) >= AUTO_UPDATE_USE_THROTTLE_MS) {
    lastUseCheck.set(key, now)
    checkForUpdate(key)
  }
}

function checkForUpdate(key: string): void {
  installations
    .get(key)
    ?.updateIfBehind()
    .catch((error: unknown) => {
      console.warn(`[managed-runtime] ${key} update check failed:`, error)
    })
}

/** Keep Orca's own copies current without a client ever prompting: once after launch, then as they're used.
 *  Installs only add a release folder, so chats on the older one keep running it. */
export function startManagedRuntimeAutoUpdates(): void {
  if (autoUpdatesStarted) {
    return
  }
  autoUpdatesStarted = true
  // Wait out startup so the first check never competes with launching the app.
  setTimeout(() => {
    for (const key of installations.keys()) {
      checkForUpdate(key)
    }
    // A server's download is large, so a chat started during startup never begins it early.
    onManagedServerUse((agent) => checkForUpdateOnUse(`server:${agent}`))
  }, AUTO_UPDATE_FIRST_CHECK_MS).unref()
  // The release lookup itself is cached for an hour.
  onManagedAgentUse((agent) => checkForUpdateOnUse(`cli:${agent}`))
}

export const MANAGED_RUNTIME_INSTALL_METHODS = [
  defineStreamingMethod({
    name: 'managedRuntime.subscribe',
    permission: 'workspace',
    params: ManagedRuntimeAgentParams,
    handler: async ({ agent }, ctx, emit) =>
      streamManagedRuntimeInstall(agent, ctx, emit, {
        selected: async () => selectedInstallation(agent, ctx.runtime),
        all: installationPrograms(agent).map((program) =>
          installationOf(agent, program, ctx.runtime)
        ),
        revisions: revisionClockFor(agent)
      })
  }),
  defineMethod({
    name: 'managedRuntime.install',
    permission: 'host-admin',
    params: ManagedRuntimeAgentParams,
    handler: async ({ agent, program }, { runtime }) => {
      const installation = selectedInstallation(agent, runtime, program)
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
      const running = installationPrograms(agent)
        .map((program) => installationOf(agent, program, runtime))
        .find((installation) => installation.runs(operationId))
      return await (running ?? selectedInstallation(agent, runtime)).cancel(operationId)
    }
  }),
  defineMethod({
    name: 'managedRuntime.remove',
    permission: 'host-admin',
    params: ManagedRuntimeAgentParams,
    handler: async ({ agent, program }, { runtime }) => {
      // An older client names a program this host no longer has; removing another would surprise.
      if (program && !installationPrograms(agent).includes(program)) {
        throw new Error('That runtime is no longer used on this host.')
      }
      const installation = selectedInstallation(agent, runtime, program)
      installation.remove()
      return installation.status()
    }
  })
] as const
