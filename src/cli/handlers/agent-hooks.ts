import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  RuntimeClientError,
  type RuntimeClient,
  type RuntimeRpcSuccess,
  getDefaultUserDataPath
} from '../runtime-client'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { getDefaultPersistedState } from '../../shared/constants'
import { normalizeDisabledTuiAgents } from '../../shared/tui-agent-selection'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import {
  applyAgentStatusHooksEnabled,
  getManagedAgentHookStatuses,
  prepareManagedCodexHomeBeforeShellLaunch
} from '../../main/agent-hooks/managed-agent-hook-controls'

type AgentHookCommandResult = {
  enabled: boolean
  settingsPath: string
  appliedBy: 'runtime' | 'offline'
  statuses: AgentHookInstallStatus[]
}

function getDataPath(): string {
  const userDataPath = getDefaultUserDataPath()
  const indexPath = join(userDataPath, 'orca-profile-index.json')
  for (const candidate of [indexPath, `${indexPath}.bak`]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf-8'))
      if (!isRecord(parsed) || !Array.isArray(parsed.profiles)) {
        continue
      }
      const profileId = parsed.activeProfileId
      if (
        typeof profileId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profileId) &&
        parsed.profiles.some((profile) => isRecord(profile) && profile.id === profileId)
      ) {
        return join(userDataPath, 'profiles', profileId, 'orca-data.json')
      }
    } catch {
      // Try the profile-index backup, then the legacy pre-profile path.
    }
  }
  return join(userDataPath, 'orca-data.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPersistedState(dataPath: string): PersistedState {
  if (!existsSync(dataPath)) {
    return getDefaultPersistedState(homedir())
  }
  try {
    const parsed = JSON.parse(readFileSync(dataPath, 'utf-8'))
    if (!isRecord(parsed)) {
      throw new Error('file does not contain a JSON object')
    }
    return parsed as PersistedState
  } catch (error) {
    throw new RuntimeClientError(
      'runtime_error',
      `Could not read ${dataPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function writePersistedState(dataPath: string, state: PersistedState): void {
  mkdirSync(dirname(dataPath), { recursive: true })
  const tmpPath = join(dirname(dataPath), `.${Date.now()}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
    renameSync(tmpPath, dataPath)
    renamed = true
  } finally {
    if (!renamed && existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort
      }
    }
  }
}

function readHookSettingsFromDisk(): Pick<
  GlobalSettings,
  'agentStatusHooksEnabled' | 'disabledTuiAgents'
> {
  const state = readPersistedState(getDataPath())
  return {
    agentStatusHooksEnabled: state.settings?.agentStatusHooksEnabled !== false,
    disabledTuiAgents: normalizeDisabledTuiAgents(state.settings?.disabledTuiAgents)
  }
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

function updateEnabledOnDisk(enabled: boolean): {
  settingsPath: string
  settings: Pick<GlobalSettings, 'agentCmdOverrides' | 'disabledTuiAgents'>
} {
  const dataPath = getDataPath()
  const state = readPersistedState(dataPath)
  state.settings = {
    ...getDefaultPersistedState(homedir()).settings,
    ...state.settings,
    agentStatusHooksEnabled: enabled
  }
  writePersistedState(dataPath, state)
  return {
    settingsPath: dataPath,
    settings: {
      agentCmdOverrides: state.settings.agentCmdOverrides ?? {},
      disabledTuiAgents: state.settings.disabledTuiAgents ?? []
    }
  }
}

async function updateRunningRuntime(client: RuntimeClient, enabled: boolean): Promise<boolean> {
  try {
    const status = await client.getCliStatus()
    if (!status.result.runtime.reachable) {
      return false
    }
    await client.call(
      'settings.update',
      { agentStatusHooksEnabled: enabled },
      { timeoutMs: 10_000 }
    )
    return true
  } catch {
    return false
  }
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
  const updatedRuntime = await updateRunningRuntime(client, enabled)
  const offlineUpdate = updatedRuntime ? null : updateEnabledOnDisk(enabled)
  const settingsPath = offlineUpdate?.settingsPath ?? getDataPath()
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
  'agent hooks prepare-codex': async ({ client }) => {
    const settings = await readHookSettings(client)
    await prepareManagedCodexHomeBeforeShellLaunch({
      userDataPath: getDefaultUserDataPath(),
      hooksEnabled:
        settings.agentStatusHooksEnabled && !settings.disabledTuiAgents.includes('codex')
    })
  },
  'agent hooks status': async ({ json }) => {
    const result: AgentHookCommandResult = {
      enabled: readHookSettingsFromDisk().agentStatusHooksEnabled,
      settingsPath: getDataPath(),
      appliedBy: 'offline',
      statuses: getManagedAgentHookStatuses()
    }
    printResult(localSuccess(result), json, formatAgentHookCommandResult)
  },
  'agent hooks off': async ({ client, json }) => {
    const result = await setAgentHooksEnabled(client, false)
    printResult(localSuccess(result), json, formatAgentHookCommandResult)
  },
  'agent hooks on': async ({ client, json }) => {
    const result = await setAgentHooksEnabled(client, true)
    printResult(localSuccess(result), json, formatAgentHookCommandResult)
  }
}
