import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getDefaultPersistedState } from '../../../shared/constants'
import { normalizeDisabledTuiAgents } from '../../../shared/tui-agent-selection'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import { profileStateJsonMatchesAcceptance } from './profile-state-documents'
import { isRecord, parseProfileStateRoot } from './profile-state-document-validation'
import {
  isProfileStateSqliteAvailable,
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from './profile-state-database'
import {
  readProfileStateDomains,
  readProfileStateDomainsWithRevisionFromDatabase
} from './profile-state-domain-reader'
import { writeProfileStateDomain } from './profile-state-domain-writes'
import { assertProfileStateCanInitialize } from './profile-state-recovery-required'
import { classifyProfileStateStorage } from './profile-state-storage-classification'

export type ProfileStateOfflineLocation = {
  dataFile: string
  databaseFile: string
  profileId: string
}

export type AgentHookSettings = Pick<
  GlobalSettings,
  'agentStatusHooksEnabled' | 'disabledTuiAgents'
>

export type AgentHookSettingsUpdate = {
  settings: Pick<GlobalSettings, 'agentCmdOverrides' | 'disabledTuiAgents'>
  settingsPath: string
}

/** Read the settings domain without creating SQLite for a JSON-only profile. */
export function readAgentHookSettingsFromProfileState(
  location: ProfileStateOfflineLocation
): AgentHookSettings {
  const classification = classifyProfileStateStorage(location.dataFile, location.databaseFile)
  if (classification === 'json-only' || classification === 'neither') {
    assertProfileStateCanInitialize(location)
    return readAgentHookSettingsFromJson(location.dataFile)
  }

  assertSqliteCapability()
  assertAcceptedLegacyJson(location, classification)
  const result = readProfileStateDomains(location.databaseFile, location.profileId, ['settings'])
  if (result.kind === 'unreadable') {
    throw result.error
  }
  return readAgentHookSettingsFromSettingsValue(result.values.get('settings'))
}

/**
 * Update only the settings row in an existing SQLite authority.
 *
 * The snapshot revision is checked again by BEGIN IMMEDIATE, so a runtime
 * writer between read and update produces a conflict instead of clobbering it.
 */
export function updateAgentHookSettingsInProfileState(
  location: ProfileStateOfflineLocation,
  enabled: boolean
): AgentHookSettingsUpdate {
  const classification = classifyProfileStateStorage(location.dataFile, location.databaseFile)
  if (classification === 'json-only' || classification === 'neither') {
    throw new Error('SQLite profile state is not established for this profile')
  }

  assertSqliteCapability()
  assertAcceptedLegacyJson(location, classification)
  const opened = openProfileStateDatabase(location.databaseFile, location.profileId)
  try {
    const domains = readProfileStateDomainsWithRevisionFromDatabase(opened.db, ['settings'])
    if (domains.kind === 'unreadable') {
      throw domains.error
    }
    const persistedSettings = domains.values.get('settings')
    const settings = {
      ...getDefaultPersistedState(homedir()).settings,
      ...(isRecord(persistedSettings) ? persistedSettings : {}),
      agentStatusHooksEnabled: enabled
    }
    writeProfileStateDomain(opened.db, {
      domain: 'settings',
      payload: JSON.stringify(settings),
      expectedRevision: domains.revision
    })
    return {
      settingsPath: location.databaseFile,
      settings: projectAgentHookSettings(settings)
    }
  } finally {
    opened.db.close()
  }
}

/** Update the active profile through its classified backend without exposing that choice to CLI callers. */
export function updateAgentHookSettingsFromProfileState(
  location: ProfileStateOfflineLocation,
  enabled: boolean
): AgentHookSettingsUpdate {
  const classification = classifyProfileStateStorage(location.dataFile, location.databaseFile)
  if (classification === 'sqlite-only' || classification === 'both') {
    return updateAgentHookSettingsInProfileState(location, enabled)
  }

  assertProfileStateCanInitialize(location)
  const state = existsSync(location.dataFile)
    ? parseProfileStateRoot(readFileSync(location.dataFile, 'utf8'))
    : structuredClone(getDefaultPersistedState(homedir()))
  const persistedSettings = isRecord(state.settings) ? state.settings : {}
  const settings = {
    ...getDefaultPersistedState(homedir()).settings,
    ...persistedSettings,
    agentStatusHooksEnabled: enabled
  }
  state.settings = settings
  writeJsonProfileState(location.dataFile, state)
  return {
    settingsPath: location.dataFile,
    settings: projectAgentHookSettings(settings)
  }
}

function projectAgentHookSettings(
  settings: AgentHookSettingsUpdate['settings']
): AgentHookSettingsUpdate['settings'] {
  return {
    agentCmdOverrides: isRecord(settings.agentCmdOverrides)
      ? Object.fromEntries(
          Object.entries(settings.agentCmdOverrides).filter(
            ([, value]) => typeof value === 'string'
          )
        )
      : {},
    disabledTuiAgents: Array.isArray(settings.disabledTuiAgents)
      ? settings.disabledTuiAgents.filter((value) => typeof value === 'string')
      : []
  }
}

function assertSqliteCapability(): void {
  if (!isProfileStateSqliteAvailable()) {
    throw new Error('SQLite profile state is present but this runtime cannot validate it')
  }
}

function assertAcceptedLegacyJson(
  location: ProfileStateOfflineLocation,
  classification: 'sqlite-only' | 'both'
): void {
  if (classification === 'sqlite-only') {
    if (!existsSync(location.databaseFile)) {
      throw new Error('SQLite profile state has an orphaned database sidecar')
    }
    return
  }

  const rawJson = readFileSync(location.dataFile, 'utf8')
  const opened = openProfileStateDatabaseReadOnly(location.databaseFile, location.profileId)
  try {
    if (!profileStateJsonMatchesAcceptance(opened.db, rawJson)) {
      throw new Error(
        'Profile state has both JSON and SQLite storage without a matching acceptance marker'
      )
    }
  } finally {
    opened.db.close()
  }
}

function readAgentHookSettingsFromJson(dataFile: string): AgentHookSettings {
  if (!existsSync(dataFile)) {
    const defaults = getDefaultPersistedState(homedir()).settings
    return {
      agentStatusHooksEnabled: defaults.agentStatusHooksEnabled !== false,
      disabledTuiAgents: normalizeDisabledTuiAgents(defaults.disabledTuiAgents)
    }
  }
  return readAgentHookSettingsFromSnapshot(readFileSync(dataFile, 'utf8'))
}

function readAgentHookSettingsFromSnapshot(raw: string): AgentHookSettings {
  const state = parseProfileStateRoot(raw)
  return readAgentHookSettingsFromSettingsValue(state.settings)
}

function readAgentHookSettingsFromSettingsValue(value: unknown): AgentHookSettings {
  const settings = isRecord(value) ? value : {}
  return {
    agentStatusHooksEnabled: settings.agentStatusHooksEnabled !== false,
    disabledTuiAgents: normalizeDisabledTuiAgents(settings.disabledTuiAgents)
  }
}

function writeJsonProfileState(dataFile: string, state: Record<string, unknown>): void {
  mkdirSync(dirname(dataFile), { recursive: true })
  writeFileDurableSync(
    durableWriteTempPath(dataFile),
    dataFile,
    `${JSON.stringify(state, null, 2)}\n`
  )
}
