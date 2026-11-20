// Install on the agent's chat host without a workspace; negotiate install.v1/remove.v1 and stream a snapshot followed by state revisions.

import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  ManagedRuntimeAgentParams,
  ManagedRuntimeCancelParams
} from '../../../../../shared/rpc-contract/host-management/managed-runtime-install-params'
import { findHostProgram } from '../../../../acp/launch/acp-launch-command'
import { ManagedRuntimeInstallation } from '../../../../node-runtime/managed-runtime-installation'
import { getProfileUserDataPath } from '../../../../orca-profiles/profile-storage-paths'
import { stopStructuredAgentChats } from '../../../agent-session/lifecycle/structured-agent-chat-stop'
import { resolveHostStructuredAgentLaunchEnvironment } from '../../../agent-session/launch/structured-agent-launch-support'
import { isPathInsideOrEqual } from '../../../../../shared/file-access/cross-platform-path'
import { defineMethod, defineStreamingMethod } from '../../core'
import { homedir } from 'node:os'
import {
  isManagedAgentCli,
  MANAGED_AGENT_CLI_IDS,
  managedAgentCli,
  onManagedAgentUse,
  rememberManagedAgentRelease,
  type ManagedAgentCliId
} from '../../../../managed-agent-cli/managed-agent-cli-registry'
import { streamManagedRuntimeInstall } from './managed-runtime-install-stream'
import { retireAntigravityServerLeftovers } from '../../../../antigravity/antigravity-server-retirement'
import {
  managedCopyMayRun,
  noteManagedReleasesRead,
  provideManagedAgentDetection,
  standInSpec
} from './managed-copy-detection'
import { hasExplicitTuiLaunchCommand } from '../../../../../shared/agent-launch/startup/tui-agent-launch-command-override'

const installations = new Map<string, ManagedRuntimeInstallation>()

/** Orca's copy of `agent`'s CLI, the one installation Install, its status and removal act on. */
function installationOf(agent: string, runtime: OrcaRuntimeService): ManagedRuntimeInstallation {
  const existing = installations.get(agent)
  if (existing) {
    return existing
  }
  if (!isManagedAgentCli(agent)) {
    throw new Error(`Orca installs no runtime for ${agent}.`)
  }
  const installation = agentCliInstallation(agent, runtime)
  installations.set(agent, installation)
  return installation
}

/** These chats run the user's own install when the host has one, so Orca's copy is the fallback. */
function agentCliInstallation(
  agent: ManagedAgentCliId,
  runtime: OrcaRuntimeService
): ManagedRuntimeInstallation {
  const managedRuntime = managedAgentCli(agent).runtime
  const dataDirectory = getProfileUserDataPath()
  const spec = standInSpec(agent)
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
    updatesEnabled: () => managedCopyMayRun(agent, runtime),
    onRelease: (folder) => rememberManagedAgentRelease(agent, folder),
    // No launch gate tracks these processes; stopping the agent's chats first is the closest fence.
    fence: (work) => stopStructuredAgentChats(agent, managedRuntime.label).then(work)
  })
}

/** Each installation reclaims stale releases when created, so create them every launch, not only when a client asks. */
export function reclaimManagedRuntimeReleasesAtLaunch(runtime: OrcaRuntimeService): void {
  provideManagedAgentDetection(runtime)
  void retireAntigravityServerLeftovers(getProfileUserDataPath())
  for (const agent of MANAGED_AGENT_CLI_IDS) {
    try {
      installationOf(agent, runtime)
    } catch (error) {
      console.warn(`[managed-runtime] ${agent} releases not reclaimed at launch:`, error)
    }
  }
  noteManagedReleasesRead()
}

const AUTO_UPDATE_FIRST_CHECK_MS = 2 * 60_000
const AUTO_UPDATE_USE_THROTTLE_MS = 10 * 60_000
let autoUpdatesStarted = false
const lastUseCheck = new Map<string, number>()

function checkForUpdate(key: string): void {
  installations
    .get(key)
    ?.updateIfBehind()
    .catch((error: unknown) => {
      console.warn(`[managed-runtime] ${key} update check failed:`, error)
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
    for (const key of installations.keys()) {
      checkForUpdate(key)
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
    handler: async ({ agent }, ctx, emit) =>
      streamManagedRuntimeInstall(agent, ctx, emit, installationOf(agent, ctx.runtime))
  }),
  defineMethod({
    name: 'managedRuntime.install',
    permission: 'host-admin',
    params: ManagedRuntimeAgentParams,
    // Older clients name the program they showed; Orca's copy of the CLI is the only one now.
    handler: async ({ agent }, { runtime }) => {
      const installation = installationOf(agent, runtime)
      installation.install()
      return installation.status()
    }
  }),
  defineMethod({
    name: 'managedRuntime.cancel',
    permission: 'host-admin',
    params: ManagedRuntimeCancelParams,
    // The outcome once the run has unwound: `cancelled`, or `succeeded` if it had committed.
    handler: async ({ agent, operationId }, { runtime }) =>
      await installationOf(agent, runtime).cancel(operationId)
  }),
  defineMethod({
    name: 'managedRuntime.remove',
    permission: 'host-admin',
    params: ManagedRuntimeAgentParams,
    handler: async ({ agent }, { runtime }) => {
      const installation = installationOf(agent, runtime)
      installation.remove()
      return installation.status()
    }
  })
] as const
