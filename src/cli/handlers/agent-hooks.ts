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
import type {
  AgentHookInstallStatus,
  RemoteAgentHookInstallReport
} from '../../shared/agent-hook-types'
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
  remotes?: RemoteAgentHookInstallReport[] | null
}

// Covers managed-home verification, WSL identity, trust grant, and bounded app-server reap.
const WSL_CODEX_PREPARE_TIMEOUT_MS = 50_000

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
  const lines = [
    `agentStatusHooksEnabled: ${result.enabled}`,
    `appliedBy: ${result.appliedBy}`,
    `settingsPath: ${result.settingsPath}`,
    statusSummary
  ].filter(Boolean)
  if (result.remotes === null) {
    lines.push('ssh: unavailable — runtime is not reachable')
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

/** Reads remote status only from a reachable runtime. Transport failures must
 * surface instead of being converted into a misleading local-only success. */
async function fetchRuntimeHookStatuses(client: RuntimeClient): Promise<{
  local: AgentHookInstallStatus[]
  remotes: RemoteAgentHookInstallReport[]
} | null> {
  const status = await client.getCliStatus()
  if (!status.result.runtime.reachable) {
    return null
  }
  const response = await client.call<{
    local: AgentHookInstallStatus[]
    remotes: RemoteAgentHookInstallReport[]
  }>('agentHooks.status', undefined, { timeoutMs: 10_000 })
  return response.result
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

/** Reads hook status from the runtime when it is reachable.
 *
 * Only a reachable runtime knows SSH-host state; transport failures must
 * surface instead of printing a false local green.
 */
async function fetchRuntimeHookStatuses(client: RuntimeClient): Promise<{
  local: AgentHookInstallStatus[]
  remotes: RemoteAgentHookInstallReport[]
} | null> {
  const status = await client.getCliStatus()
  if (!status.result.runtime.reachable) {
    return null
  }
  const response = await client.call<{
    local: AgentHookInstallStatus[]
    remotes: RemoteAgentHookInstallReport[]
  }>('agentHooks.status', undefined, { timeoutMs: 10_000 })
  return response.result
}

export const AGENT_HOOK_HANDLERS: Record<string, CommandHandler> = {
  'agent hooks prepare-codex': async ({ client }) => {
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
  'agent hooks status': async ({ client, json }) => {
    const runtimeStatuses = await fetchRuntimeHookStatuses(client)
    const result: AgentHookCommandResult = {
      enabled: readHookSettingsFromDisk().agentStatusHooksEnabled,
      settingsPath: getDataPath(),
      appliedBy: runtimeStatuses ? 'runtime' : 'offline',
      statuses: runtimeStatuses?.local ?? getManagedAgentHookStatuses(),
      remotes: runtimeStatuses?.remotes ?? null
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
