import { unlinkSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { parseHooksJsonText, readHooksJsonWithRaw } from '../agent-hooks/hooks-json-read'
import { writeHooksJson } from '../agent-hooks/installer-utils'
import { readTextFileRemote, writeHooksJsonRemote } from '../agent-hooks/installer-utils-remote'
import {
  buildKiroStandaloneHooksFile,
  getKiroStandaloneHooksFileConflict,
  getKiroStandaloneHooksFilePath,
  KIRO_STANDALONE_HOOK_TRIGGERS,
  readManagedKiroStandaloneTriggers,
  removeManagedKiroStandaloneHooks
} from './standalone-hook-settings'

function standaloneStatus(
  configPath: string,
  state: AgentHookInstallState,
  detail: string | null,
  managedHooksPresent = false
): AgentHookInstallStatus {
  return { agent: 'kiro', state, configPath, managedHooksPresent, detail }
}

function getExistingFileStatus(
  configPath: string,
  file: Record<string, unknown> | null
): AgentHookInstallStatus {
  if (!file) {
    return standaloneStatus(configPath, 'error', 'Could not parse the Orca Kiro hooks file')
  }
  const conflict = getKiroStandaloneHooksFileConflict(file)
  if (conflict) {
    return standaloneStatus(
      configPath,
      'error',
      `Left the Kiro hooks file at Orca's path untouched: ${conflict}`,
      readManagedKiroStandaloneTriggers(file).size > 0
    )
  }
  const active = readManagedKiroStandaloneTriggers(file, { activeOnly: true })
  const missing = KIRO_STANDALONE_HOOK_TRIGGERS.filter((trigger) => !active.has(trigger))
  return missing.length === 0
    ? standaloneStatus(configPath, 'installed', null, true)
    : standaloneStatus(configPath, 'partial', `events: ${missing.join(', ')}`, true)
}

export function getKiroStandaloneHooksStatus(): AgentHookInstallStatus {
  const configPath = getKiroStandaloneHooksFilePath()
  const { raw, config } = readHooksJsonWithRaw(configPath)
  if (raw === null) {
    return config
      ? standaloneStatus(configPath, 'not_installed', null)
      : standaloneStatus(configPath, 'error', 'Could not read the Orca Kiro hooks file')
  }
  return getExistingFileStatus(configPath, config)
}

export function installKiroStandaloneHooks(command: string): AgentHookInstallStatus {
  const configPath = getKiroStandaloneHooksFilePath()
  const { raw, config } = readHooksJsonWithRaw(configPath)
  // A file someone else wrote at Orca's name keeps its hooks.
  if (config && (raw === null || getKiroStandaloneHooksFileConflict(config) === null)) {
    writeHooksJson(configPath, buildKiroStandaloneHooksFile(command))
  }
  return getKiroStandaloneHooksStatus()
}

export async function installKiroStandaloneHooksRemote(
  sftp: SFTPWrapper,
  configPath: string,
  command: string
): Promise<AgentHookInstallStatus> {
  try {
    const body = await readTextFileRemote(sftp, configPath)
    if (body !== null) {
      const existing = getExistingFileStatus(configPath, parseHooksJsonText(body))
      if (existing.state === 'error') {
        return existing
      }
    }
    await writeHooksJsonRemote(sftp, configPath, buildKiroStandaloneHooksFile(command))
    return standaloneStatus(configPath, 'installed', null, true)
  } catch (err) {
    return standaloneStatus(configPath, 'error', err instanceof Error ? err.message : String(err))
  }
}

export function removeKiroStandaloneHooks(): AgentHookInstallStatus {
  const configPath = getKiroStandaloneHooksFilePath()
  const { config } = readHooksJsonWithRaw(configPath)
  if (config && readManagedKiroStandaloneTriggers(config).size > 0) {
    if (getKiroStandaloneHooksFileConflict(config) === null) {
      unlinkSync(configPath)
    } else {
      writeHooksJson(configPath, removeManagedKiroStandaloneHooks(config))
    }
  }
  return getKiroStandaloneHooksStatus()
}

/** Agent-config status stays primary; the V3 file adds coverage or surfaces its error. */
export function withKiroStandaloneHooksStatus(
  primary: AgentHookInstallStatus,
  standalone: AgentHookInstallStatus
): AgentHookInstallStatus {
  if (standalone.state === 'installed' && primary.state === 'not_installed') {
    return { ...primary, state: 'partial', managedHooksPresent: true }
  }
  if (standalone.state !== 'error') {
    return primary
  }
  const detail = `${standalone.configPath}: ${standalone.detail}`
  return {
    ...primary,
    state: primary.state === 'installed' ? 'partial' : primary.state,
    detail: primary.detail ? `${primary.detail}; ${detail}` : detail
  }
}
