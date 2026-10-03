import { join } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import {
  RuntimeClientError,
  RuntimeRpcFailureError,
  type RuntimeClient,
  type RuntimeRpcSuccess,
  getDefaultUserDataPath
} from '../runtime-client'
import type {
  AgentHookInstallStatus,
  RemoteAgentHookInstallReport
} from '../../shared/agent-hook-types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../shared/orca-profiles'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ProfileStateOfflineLocation } from '../../main/persistence/profile-state/profile-state-offline-settings'

type AgentHookCommandResult = {
  enabled: boolean
  settingsPath: string
  appliedBy: 'runtime' | 'offline'
  statuses: AgentHookInstallStatus[]
  remotes?: RemoteAgentHookInstallReport[] | null
  remotesUnavailableReason?: string
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
  const lines = [
    `agentStatusHooksEnabled: ${result.enabled}`,
    `appliedBy: ${result.appliedBy}`,
    `settingsPath: ${result.settingsPath}`,
    statusSummary
  ].filter(Boolean)
  if (result.remotes === null) {
    lines.push(
      `ssh: unavailable — ${result.remotesUnavailableReason ?? 'runtime is not reachable'}`
    )
  }
  for (const remote of result.remotes ?? []) {
    lines.push(formatRemoteReport(remote))
  }
  return lines.join('\n')
}

/** Formats one remote host's managed-hook install report for human CLI output. */
function formatRemoteReport(remote: RemoteAgentHookInstallReport): string {
  const header = `ssh:${remote.targetId}: ${remote.state}${remote.detail ? ` — ${remote.detail}` : ''}`
  const agentLines = remote.statuses.map((status) => {
    const detail = status.state !== 'installed' && status.detail ? ` — ${status.detail}` : ''
    return `  ${status.agent}: ${status.state}${detail}`
  })
  return [header, ...agentLines].join('\n')
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

// Only method absence permits local diagnostics; transport failures remain errors.
async function fetchRuntimeHookStatuses(client: RuntimeClient): Promise<{
  local: AgentHookInstallStatus[] | null
  remotes: RemoteAgentHookInstallReport[] | null
  remotesUnavailableReason?: string
}> {
  const status = await client.getCliStatus()
  if (!status.result.runtime.reachable) {
    return { local: null, remotes: null, remotesUnavailableReason: 'runtime is not reachable' }
  }
  try {
    const response = await client.call<{
      local: AgentHookInstallStatus[]
      remotes: RemoteAgentHookInstallReport[]
    }>('agentHooks.status', undefined, { timeoutMs: 10_000 })
    return response.result
  } catch (error) {
    if (error instanceof RuntimeRpcFailureError && error.code === 'method_not_found') {
      return {
        local: null,
        remotes: null,
        remotesUnavailableReason: 'runtime does not support SSH hook status'
      }
    }
    throw error
  }
}

export const AGENT_HOOK_HANDLERS: Record<string, CommandHandler> = {
  'agent hooks prepare-codex': async ({ client, flags }) => {
    rejectRemoteHookSelection(flags)
    if (!process.env.WSL_DISTRO_NAME?.trim()) {
      // Why a no-op: native pane wrappers from builds up to v1.4.216 still call it; delete once no supported build's wrapper does.
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
    const runtimeStatuses = await fetchRuntimeHookStatuses(client)
    const { getManagedAgentHookStatuses } =
      await import('../../main/agent-hooks/managed-agent-hook-controls.js')
    const result: AgentHookCommandResult = {
      enabled: (await readHookSettingsFromDisk()).agentStatusHooksEnabled,
      settingsPath: await getDataPath(),
      appliedBy: runtimeStatuses.local ? 'runtime' : 'offline',
      statuses: runtimeStatuses.local ?? getManagedAgentHookStatuses(),
      remotes: runtimeStatuses.remotes,
      ...(runtimeStatuses.remotesUnavailableReason
        ? { remotesUnavailableReason: runtimeStatuses.remotesUnavailableReason }
        : {})
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
