import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../shared/orca-profiles'
import { PROFILE_STATE_DATABASE_FILE_NAME } from '../../shared/profile-state-storage-paths'
import {
  getEphemeralVmRuntimeStorePath,
  MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES
} from '../../shared/ephemeral-vm-runtime-store'
import { EphemeralVmRuntimeStoreSchema } from '../../shared/ephemeral-vm-runtimes'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { isQualifiedPluginKey } from '../../shared/plugins/frames/plugin-tab-key'
import { getActiveProfileStateLocation } from '../persistence/profile-state/profile-state-active-location'
import { readProfileStateDomain } from '../persistence/profile-state/profile-state-domain-reader'
import { classifyProfileStateStorage } from '../persistence/profile-state/profile-state-storage-classification'
import { PLUGIN_CURRENT_POINTER_FILENAME } from '../plugins/installation/plugin-current-pointer'

// These probes never create, lock, migrate or harden state owned by the next serve host.

/** Read one top-level state key (== SQLite domain name) of the active profile; undefined when absent. */
function readActiveProfileState(userDataPath: string, key: 'sshTargets' | 'settings'): unknown {
  // Before profile indexes existed, state lived at the legacy root paths.
  const location = getActiveProfileStateLocation(userDataPath) ?? {
    dataFile: join(userDataPath, 'orca-data.json'),
    databaseFile: join(userDataPath, PROFILE_STATE_DATABASE_FILE_NAME),
    profileId: DEFAULT_LOCAL_ORCA_PROFILE_ID
  }
  const storage = classifyProfileStateStorage(location.dataFile, location.databaseFile)
  if (storage === 'neither') {
    return undefined
  }
  if (storage === 'json-only') {
    const parsed: unknown = JSON.parse(readFileSync(location.dataFile, 'utf8'))
    if (!isRecord(parsed)) {
      // The profile-state parser rejects a non-object root, so an unusable file must not read as "no feature".
      throw new Error('the profile state is not an object')
    }
    return parsed[key]
  }
  const result = readProfileStateDomain(location.databaseFile, location.profileId, key)
  if (result.kind === 'unreadable') {
    throw result.error
  }
  return result.kind === 'value' ? result.value : undefined
}

/** Inspect SSH targets in the active profile's state. */
export function serveProfileHasSshTargets(userDataPath: string): boolean {
  return hasEntries(readActiveProfileState(userDataPath, 'sshTargets'))
}

/** Dev plugin paths load through PluginService like installs, so they also need the desktop server. */
function serveProfileHasDevPluginPaths(userDataPath: string): boolean {
  const settings = readActiveProfileState(userDataPath, 'settings')
  return isRecord(settings) && hasEntries(settings.devPluginPaths)
}

/** An install is a qualified-key directory with a current pointer, as discovery sees it; the lockfile can lag. Saved dev plugin paths count too. */
export function serveProfileHasInstalledPlugins(userDataPath: string): boolean {
  return (
    serveProfileHasPluginDirectoryInstall(userDataPath) ||
    serveProfileHasDevPluginPaths(userDataPath)
  )
}

function serveProfileHasPluginDirectoryInstall(userDataPath: string): boolean {
  // Mirrors getUserPluginsDir without pulling plugin discovery (manifest schemas, yaml) into every serve.
  const pluginsDir = join(userDataPath, 'plugins')
  let entries
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true })
  } catch (error) {
    if (isMissingPath(error)) {
      return false
    }
    throw error
  }
  return entries.some(
    (entry) =>
      entry.isDirectory() &&
      isQualifiedPluginKey(entry.name) &&
      existsSync(join(pluginsDir, entry.name, PLUGIN_CURRENT_POINTER_FILENAME))
  )
}

/** The store's own reader hardens and may rewrite the file, so read it raw under the same cap. */
export function serveProfileHasEphemeralVmRuntimes(userDataPath: string): boolean {
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  if (!existsSync(path)) {
    return false
  }
  const parsed: unknown = JSON.parse(
    // A FIFO here would block serve startup, so refuse non-regular files without opening them.
    readNodeFileSyncWithinLimit(path, MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES, {
      regularFileOnly: true
    }).buffer.toString('utf8')
  )
  // Same schema as the store's reader, so a shape it would reject can't read as "nothing live".
  const store = EphemeralVmRuntimeStoreSchema.parse(parsed)
  // Destroyed VMs keep their records forever; only live ones need the desktop server.
  return store.runtimes.some((runtime) => runtime.status !== 'cleaned')
}

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
