import { join } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import {
  RuntimeClientError,
  type RuntimeClient,
  type RuntimeRpcSuccess,
  getDefaultUserDataPath
} from '../runtime-client'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../shared/orca-profiles'
import { normalizeDisabledTuiAgents } from '../../shared/tui-agent-selection'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { prepareManagedCodexHomeBeforeShellLaunch } from '../../main/codex/managed-home-shell-preflight'
import type { ProfileStateOfflineLocation } from '../../main/persistence/profile-state/profile-state-offline-settings'

type AgentHookCommandResult = {
  enabled: boolean
  settingsPath: string
  appliedBy: 'runtime' | 'offline'
  statuses: AgentHookInstallStatus[]
}

// Covers managed-home verification, WSL identity, trust grant, and bounded app-server reap.
const WSL_CODEX_PREPARE_TIMEOUT_MS = 50_000

async function getDataPath(): Promise<string> {
  return (
    (await getProfileStateLocation())?.dataFile ?? join(getDefaultUserDataPath(), 'orca-data.json')
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
    await import('../../main/persistence/profile-state/profile-state-access.js')
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
    await import('../../main/persistence/profile-state/profile-state-offline-settings.js')
  return readAgentHookSettingsFromProfileState(
    (await getProfileStateLocation()) ?? legacyProfileStateLocation()
  )
}

async function readHookSettings(
  client: RuntimeClient
): Promise<Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>> {
  try {
    const response = await client.call<{
      settings?: Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>
    }>('settings.get', undefined, { timeoutMs: 1_000 })
    const settings = response.result.settings
    if (settings && typeof settings.agentStatusHooksEnabled === 'boolean') {
      return {
        agentStatusHooksEnabled: settings.agentStatusHooksEnabled,
        disabledTuiAgents: normalizeDisabledTuiAgents(settings.disabledTuiAgents)
      }
    }
  } catch {
    // The active profile on disk is the offline fallback.
  }
  return readHookSettingsFromDisk()
}

async function updateEnabledOnDisk(enabled: boolean): Promise<{
  settingsPath: string
  settings: Pick<GlobalSettings, 'agentCmdOverrides' | 'disabledTuiAgents'>
}> {
  const { assertOfflineProfileStateMutationRuntime } =
    await import('../../main/persistence/profile-state/profile-state-offline-settings.js')
  assertOfflineProfileStateMutationRuntime()
  const { acquireProfileStateMaintenance } =
    await import('../../main/persistence/profile-state/profile-state-access.js')
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
    await import('../../main/persistence/profile-state/profile-state-offline-settings.js')
  let location = await getProfileStateLocation()
  if (!location) {
    const legacy = legacyProfileStateLocation()
    const { classifyProfileStateStorage } =
      await import('../../main/persistence/profile-state/profile-state-storage-classification.js')
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
  const status = await client.getCliStatus()
  if (!status.result.runtime.reachable) {
    if (status.result.app.running) {
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
  const statusSummary = result.statuses
    .map((status) => `${status.agent}: ${status.state}`)
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
    await import('../../main/agent-hooks/managed-agent-hook-controls.js')
  const updatedRuntime = await updateRunningRuntime(client, enabled)
  const offlineUpdate = updatedRuntime ? null : await updateEnabledOnDisk(enabled)
  const settingsPath = offlineUpdate?.settingsPath ?? (await getDataPath())
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
    if (process.env.WSL_DISTRO_NAME?.trim()) {
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
      return
    }
    const settings = await readHookSettings(client)
    await prepareManagedCodexHomeBeforeShellLaunch({
      userDataPath: getDefaultUserDataPath(),
      hooksEnabled:
        settings.agentStatusHooksEnabled && !settings.disabledTuiAgents.includes('codex')
    })
  },
  'agent hooks status': async ({ json, flags }) => {
    rejectRemoteHookSelection(flags)
    const { getManagedAgentHookStatuses } =
      await import('../../main/agent-hooks/managed-agent-hook-controls.js')
    const result: AgentHookCommandResult = {
      enabled: (await readHookSettingsFromDisk()).agentStatusHooksEnabled,
      settingsPath: await getDataPath(),
      appliedBy: 'offline',
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
