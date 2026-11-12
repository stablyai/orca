import { join } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../command-result-output'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { RuntimeClientError } from '../runtime/types'
import type { RuntimeClient } from '../runtime/client'
import type { RuntimeRpcSuccess } from '../../shared/runtime-rpc-envelope'
import { getDefaultUserDataPath } from '../runtime/metadata'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-listener/configuration/agent-hook-types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../shared/orca-profiles'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ProfileStateOfflineLocation } from '../../main/persistence/profile-state/offline-access/profile-state-offline-settings'

type AgentHookCommandResult = {
  enabled: boolean
  settingsPath: string
  appliedBy: 'runtime' | 'offline'
  statuses: AgentHookInstallStatus[]
}

// Covers managed-home verification, WSL identity, trust grant, and bounded app-server reap.
const WSL_CODEX_PREPARE_TIMEOUT_MS = 50_000

async function getSettingsPath(): Promise<string> {
  const { resolveAgentHookSettingsPath } =
    await import('../../main/persistence/profile-state/offline-access/profile-state-offline-settings.js')
  return resolveAgentHookSettingsPath(
    (await getProfileStateLocation()) ?? legacyProfileStateLocation()
  )
}

async function getProfileStateLocation(): Promise<ProfileStateOfflineLocation | undefined> {
  const { getActiveProfileStateLocation } = await import('../profile-state-location.js')
  return getActiveProfileStateLocation()
}

function legacyProfileStateLocation(): ProfileStateOfflineLocation {
  const userDataPath = getDefaultUserDataPath()
  return {
    dataFile: join(userDataPath, 'orca-data.json'),
    databaseFile: join(userDataPath, 'profile-state.db'),
    profileId: DEFAULT_LOCAL_ORCA_PROFILE_ID
  }
}

async function readHookSettingsFromDisk(): Promise<
  Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>
> {
  const { acquireProfileStateRuntimeAdmission } =
    await import('../../main/persistence/profile-state/access/profile-state-access.js')
  const admission = acquireProfileStateRuntimeAdmission(getDefaultUserDataPath())
  try {
    return await readAdmittedHookSettingsFromDisk()
  } finally {
    admission.release()
  }
}

async function readAdmittedHookSettingsFromDisk(): Promise<
  Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>
> {
  const { readAgentHookSettingsFromProfileState } =
    await import('../../main/persistence/profile-state/offline-access/profile-state-offline-settings.js')
  return readAgentHookSettingsFromProfileState(
    (await getProfileStateLocation()) ?? legacyProfileStateLocation()
  )
}

async function updateEnabledOnDisk(enabled: boolean): Promise<{
  settingsPath: string
  settings: Pick<GlobalSettings, 'agentCmdOverrides' | 'disabledTuiAgents'>
}> {
  const { assertOfflineProfileStateMutationRuntime } =
    await import('../../main/persistence/profile-state/offline-access/profile-state-offline-settings.js')
  assertOfflineProfileStateMutationRuntime()
  const { acquireProfileStateMaintenance } =
    await import('../../main/persistence/profile-state/access/profile-state-access.js')
  // A stopped-status response cannot exclude startup racing the first import.
  const maintenance = acquireProfileStateMaintenance(getDefaultUserDataPath())
  try {
    return await updateAdmittedEnabledOnDisk(enabled)
  } finally {
    maintenance.release()
  }
}

async function updateAdmittedEnabledOnDisk(enabled: boolean): Promise<{
  settingsPath: string
  settings: Pick<GlobalSettings, 'agentCmdOverrides' | 'disabledTuiAgents'>
}> {
  const { updateAgentHookSettingsFromProfileState, readAgentHookSettingsFromProfileState } =
    await import('../../main/persistence/profile-state/offline-access/profile-state-offline-settings.js')
  let location = await getProfileStateLocation()
  if (!location) {
    const legacy = legacyProfileStateLocation()
    const { classifyProfileStateStorage } =
      await import('../../main/persistence/profile-state/database/profile-state-storage-classification.js')
    const storage = classifyProfileStateStorage(legacy.dataFile, legacy.databaseFile)
    if (storage !== 'json-only' && storage !== 'neither') {
      throw new RuntimeClientError('runtime_error', 'Profile state has no active profile index.')
    }
    // Validate retained recovery evidence and source bytes before creating the index.
    readAgentHookSettingsFromProfileState(legacy)
    const { ensureActiveOrcaProfile } =
      await import('../../main/orca-profiles/profile-index-store.js')
    const profile = ensureActiveOrcaProfile(getDefaultUserDataPath())
    location = {
      dataFile: profile.dataFile,
      databaseFile: profile.stateDatabaseFile,
      profileId: profile.profile.id
    }
  }
  return updateAgentHookSettingsFromProfileState(location, enabled)
}

async function updateRunningRuntime(client: RuntimeClient, enabled: boolean): Promise<boolean> {
  const status = await client.getOfflineRuntimeAdmission()
  if (!status.reachable) {
    if (status.legacyPidRunning) {
      throw new RuntimeClientError(
        'runtime_error',
        'Orca is running but unavailable. Retry when it responds, or stop Orca before changing agent hooks offline.'
      )
    }
    return false
  }
  await client.call('settings.update', { agentStatusHooksEnabled: enabled }, { timeoutMs: 10_000 })
  return true
}

/** Null when no runtime answers; a running app owns the live setting. */
async function readRunningRuntimeHooksEnabled(client: RuntimeClient): Promise<boolean | null> {
  if (!(await client.getOfflineRuntimeAdmission()).reachable) {
    return null
  }
  const response = await client.call<{
    settings: Pick<GlobalSettings, 'agentStatusHooksEnabled'>
  }>('settings.get')
  return response.result.settings.agentStatusHooksEnabled !== false
}

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return {
    id: 'local',
    ok: true,
    result,
    _meta: {
      runtimeId: 'local'
    }
  }
}

function formatAgentHookCommandResult(result: AgentHookCommandResult): string {
  // The CLI and app panes may use different homes; identify the one this status describes.
  const statusSummary = result.statuses
    .map((status) => {
      const showDetail = status.detail && (status.state === 'partial' || status.state === 'error')
      const path = status.configPath ? ` (${status.configPath})` : ''
      return `${status.agent}: ${status.state}${path}${showDetail ? ` - ${status.detail}` : ''}`
    })
    .join('\n')
  return [
    `agentStatusHooksEnabled: ${result.enabled}`,
    `appliedBy: ${result.appliedBy}`,
    `settingsPath: ${result.settingsPath}`,
    statusSummary
  ]
    .filter(Boolean)
    .join('\n')
}

async function setAgentHooksEnabled(
  client: RuntimeClient,
  enabled: boolean
): Promise<AgentHookCommandResult> {
  const { applyAgentStatusHooksEnabled, getManagedAgentHookStatuses } =
    await import('../../main/agent-hooks/installation/managed-agent-hook-controls.js')
  const updatedRuntime = await updateRunningRuntime(client, enabled)
  const offlineUpdate = updatedRuntime ? null : await updateEnabledOnDisk(enabled)
  const settingsPath = offlineUpdate?.settingsPath ?? (await getSettingsPath())
  const statuses = updatedRuntime
    ? getManagedAgentHookStatuses()
    : await applyAgentStatusHooksEnabled(enabled, offlineUpdate?.settings)
  return {
    enabled,
    settingsPath,
    appliedBy: updatedRuntime ? 'runtime' : 'offline',
    statuses
  }
}

export const AGENT_HOOK_HANDLERS: Record<string, CommandHandler> = {
  'agent hooks prepare-codex': async ({ client, flags }) => {
    rejectRemoteHookSelection(flags)
    if (!process.env.WSL_DISTRO_NAME?.trim()) {
      // Native wrappers through v1.4.216 still call this; retain the no-op until they are unsupported.
      return
    }
    try {
      await client.call(
        'agentHooks.prepareCodexForWslPane',
        {
          codexHome: process.env.CODEX_HOME ?? '',
          orcaCodexHome: process.env.ORCA_CODEX_HOME ?? '',
          wslDistro: process.env.WSL_DISTRO_NAME
        },
        { timeoutMs: WSL_CODEX_PREPARE_TIMEOUT_MS }
      )
    } catch {
      // Best effort: old or unavailable runtimes must not block Codex launch.
    }
  },
  'agent hooks status': async ({ client, json, flags }) => {
    rejectRemoteHookSelection(flags)
    const { getManagedAgentHookStatuses } =
      await import('../../main/agent-hooks/installation/managed-agent-hook-controls.js')
    const runtimeEnabled = await readRunningRuntimeHooksEnabled(client)
    const result: AgentHookCommandResult = {
      enabled: runtimeEnabled ?? (await readHookSettingsFromDisk()).agentStatusHooksEnabled,
      settingsPath: await getSettingsPath(),
      appliedBy: runtimeEnabled === null ? 'offline' : 'runtime',
      statuses: getManagedAgentHookStatuses()
    }
    printResult(localSuccess(result), json, formatAgentHookCommandResult)
  },
  'agent hooks off': async ({ client, json, flags }) => {
    rejectRemoteHookSelection(flags)
    const result = await setAgentHooksEnabled(client, false)
    printResult(localSuccess(result), json, formatAgentHookCommandResult)
  },
  'agent hooks on': async ({ client, json, flags }) => {
    rejectRemoteHookSelection(flags)
    const result = await setAgentHooksEnabled(client, true)
    printResult(localSuccess(result), json, formatAgentHookCommandResult)
  }
}

function rejectRemoteHookSelection(flags: ReadonlyMap<string, string | boolean>): void {
  rejectRemoteSelectionFlags(
    flags,
    'agent hooks; run this command on the machine whose hooks you want to manage.'
  )
}
