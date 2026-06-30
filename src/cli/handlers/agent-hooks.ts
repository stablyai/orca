import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from '../runtime-client'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState } from '../../shared/types'
import {
  applyAgentStatusHooksEnabled,
  getManagedAgentHookStatuses
} from '../../main/agent-hooks/managed-agent-hook-controls'
import { getDefaultUserDataPath } from '../runtime-client'

type AgentHookCommandResult = {
  enabled: boolean
  settingsPath: string
  appliedBy: 'runtime' | 'offline'
  statuses: AgentHookInstallStatus[]
}

function getDataPath(): string {
  return join(getDefaultUserDataPath(), 'orca-data.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPersistedState(dataPath: string): PersistedState {
  if (!existsSync(dataPath)) {
    const defaults = getDefaultPersistedState(homedir())
    return {
      ...defaults,
      settings: {
        ...defaults.settings,
        // Why: offline CLI can create the first profile before desktop load;
        // match the Store fresh-install default instead of pinning old cards.
        experimentalNewWorktreeCardStyle: true
      }
    }
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

function readEnabledFromDisk(): boolean {
  const state = readPersistedState(getDataPath())
  return state.settings?.agentStatusHooksEnabled !== false
}

function updateEnabledOnDisk(enabled: boolean): string {
  const dataPath = getDataPath()
  const state = readPersistedState(dataPath)
  const experimentalNewWorktreeCardStyle =
    state.settings?.experimentalNewWorktreeCardStyle ?? state.onboarding?.closedAt === null
  state.settings = {
    ...getDefaultPersistedState(homedir()).settings,
    ...state.settings,
    // Why: offline CLI can run before Store.load(); mirror its open-onboarding
    // default without overriding a saved user opt-out.
    experimentalNewWorktreeCardStyle,
    agentStatusHooksEnabled: enabled
  }
  writePersistedState(dataPath, state)
  return dataPath
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
  const settingsPath = updatedRuntime ? getDataPath() : updateEnabledOnDisk(enabled)
  const statuses = updatedRuntime
    ? getManagedAgentHookStatuses()
    : applyAgentStatusHooksEnabled(enabled)
  return {
    enabled,
    settingsPath,
    appliedBy: updatedRuntime ? 'runtime' : 'offline',
    statuses
  }
}

export const AGENT_HOOK_HANDLERS: Record<string, CommandHandler> = {
  'agent hooks status': async ({ json }) => {
    const result: AgentHookCommandResult = {
      enabled: readEnabledFromDisk(),
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
