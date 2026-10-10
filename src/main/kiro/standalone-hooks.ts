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

/** Status of a hooks file that exists at Orca's path; `file` is null when it did not parse. */
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

/** Status of the global hooks file kiro-cli's V3 engine loads for every agent. */
export function getKiroStandaloneHooksStatus(): AgentHookInstallStatus {
  const configPath = getKiroStandaloneHooksFilePath()
  const { raw, config } = readHooksJsonWithRaw(configPath)
  if (raw === null) {
    // readHooksJsonWithRaw answers {} for a missing file and null for one it could not read.
    return config
      ? standaloneStatus(configPath, 'not_installed', null)
      : standaloneStatus(configPath, 'error', 'Could not read the Orca Kiro hooks file')
  }
  return getExistingFileStatus(configPath, config)
}

export function installKiroStandaloneHooks(command: string): AgentHookInstallStatus {
  const configPath = getKiroStandaloneHooksFilePath()
  const { raw, config } = readHooksJsonWithRaw(configPath)
  // Why: the name is Orca's, but a file someone else wrote there keeps its hooks.
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
    // Why: delete the file only when all of it is Orca's; hooks someone else added stay.
    if (getKiroStandaloneHooksFileConflict(config) === null) {
      unlinkSync(configPath)
    } else {
      writeHooksJson(configPath, removeManagedKiroStandaloneHooks(config))
    }
  }
  return getKiroStandaloneHooksStatus()
}

/**
 * Agent-config hooks stay the primary status (the default engine); the V3 file only surfaces
 * when Orca could not read or write it, which also keeps `installed` from overstating coverage.
 */
export function withKiroStandaloneHooksStatus(
  primary: AgentHookInstallStatus,
  standalone: AgentHookInstallStatus
): AgentHookInstallStatus {
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
