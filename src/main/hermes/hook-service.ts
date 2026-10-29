import { rmSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'

import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  listRemoteDirectory,
  readTextFileRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import type { HermesConfig } from './hermes-config-yaml'
import {
  disablePlugin,
  enablePlugin,
  getConfigEnablement,
  installOrcaStatusContent,
  parseHermesConfig,
  refreshProfileOrcaStatusContent,
  removeOrcaStatusContent,
  updateConfigContent
} from './hermes-config-yaml'
import { getHermesHome } from './hermes-default-home'
import {
  getConfigPath,
  getPluginDir,
  getPluginFilesState,
  listManagedProfileHomes,
  readConfigFile,
  writeConfigFile,
  writePluginFiles
} from './hermes-home-filesystem'
import {
  HERMES_EVENTS,
  HERMES_PLUGIN_MARKER,
  HERMES_PLUGIN_NAME,
  getPluginInitSource,
  getPluginManifest
} from './hermes-managed-plugin-source'

function buildStatus(configPath: string, config: HermesConfig): AgentHookInstallStatus {
  const pluginFiles = getPluginFilesState()
  const enablement = getConfigEnablement(config)
  const details = [
    pluginFiles.detail,
    enablement.detail,
    !enablement.enabled ? 'orca-status is not enabled in Hermes config.yaml' : null,
    enablement.disabled ? 'orca-status is disabled in Hermes config.yaml' : null
  ].filter((detail): detail is string => Boolean(detail))

  let state: AgentHookInstallState
  if (!pluginFiles.present && !enablement.enabled) {
    state = 'not_installed'
  } else if (
    pluginFiles.present &&
    pluginFiles.managed &&
    enablement.enabled &&
    !enablement.disabled
  ) {
    state = 'installed'
  } else {
    state = 'partial'
  }

  return {
    agent: 'hermes',
    state,
    configPath,
    managedHooksPresent: pluginFiles.present && pluginFiles.managed,
    detail: state === 'installed' || state === 'not_installed' ? null : details.join('; ')
  }
}

// Why: each named profile loads plugins and client_env_passthrough from its own home, so a copy there must track Orca's.
function updateManagedProfiles(
  update: (content: string | null) => { content: string | null },
  onUpdated: (pluginDir: string) => void
): void {
  for (const home of listManagedProfileHomes()) {
    try {
      const configPath = getConfigPath(home)
      const parsed = readConfigFile(configPath)
      const next = parsed.ok ? update(parsed.content) : { content: null }
      if (!parsed.ok || next.content === null) {
        continue
      }
      // Config first: a failed write must not leave orca-status enabled without its plugin.
      if (next.content !== parsed.content) {
        writeConfigFile(configPath, next.content)
      }
      onUpdated(getPluginDir(home))
    } catch (error) {
      console.warn(`[hermes] skipped profile ${home}:`, error)
    }
  }
}

async function writeRemoteHome(
  sftp: SFTPWrapper,
  home: string,
  existing: string | null,
  content: string
): Promise<void> {
  const pluginDir = `${home}/plugins/${HERMES_PLUGIN_NAME}`
  await writeTextFileRemoteAtomic(sftp, `${pluginDir}/plugin.yaml`, getPluginManifest())
  await writeTextFileRemoteAtomic(sftp, `${pluginDir}/__init__.py`, getPluginInitSource())
  if (content !== existing) {
    await writeTextFileRemoteAtomic(sftp, `${home}/config.yaml`, content)
  }
}

async function installRemoteManagedProfiles(sftp: SFTPWrapper, profilesDir: string): Promise<void> {
  const names = await listRemoteDirectory(sftp, profilesDir).catch((error: unknown) => {
    console.warn(`[hermes] could not list remote profiles in ${profilesDir}:`, error)
    return null
  })
  for (const name of names ?? []) {
    const home = `${profilesDir}/${name}`
    const pluginDir = `${home}/plugins/${HERMES_PLUGIN_NAME}`
    try {
      const files = await Promise.all(
        ['plugin.yaml', '__init__.py'].map((file) =>
          readTextFileRemote(sftp, `${pluginDir}/${file}`)
        )
      )
      if (!files.every((file) => file?.includes(HERMES_PLUGIN_MARKER))) {
        continue
      }
      const existing = await readTextFileRemote(sftp, `${home}/config.yaml`)
      const next = refreshProfileOrcaStatusContent(existing)
      if (next.content !== null) {
        await writeRemoteHome(sftp, home, existing, next.content)
      }
    } catch (error) {
      console.warn(`[hermes] skipped remote profile ${home}:`, error)
    }
  }
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '')
}

export class HermesHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const parsed = readConfigFile(configPath)
    if (!parsed.ok) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath,
        managedHooksPresent: getPluginFilesState().managed,
        detail: `Could not parse Hermes config.yaml: ${parsed.detail}`
      }
    }
    return buildStatus(configPath, parsed.config)
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const parsed = readConfigFile(configPath)
    if (!parsed.ok) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath,
        managedHooksPresent: getPluginFilesState().managed,
        detail: `Could not parse Hermes config.yaml: ${parsed.detail}`
      }
    }

    const next = installOrcaStatusContent(parsed.content)
    if (next.content === null) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath,
        managedHooksPresent: getPluginFilesState().managed,
        detail: `Could not update Hermes config.yaml: ${next.detail ?? 'unknown error'}`
      }
    }
    writePluginFiles()
    if (next.content !== parsed.content) {
      writeConfigFile(configPath, next.content)
    }
    updateManagedProfiles(refreshProfileOrcaStatusContent, writePluginFiles)
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteRoot = stripTrailingSlash(remoteHome)
    const remoteConfigPath = `${remoteRoot}/.hermes/config.yaml`
    try {
      const existing = await readTextFileRemote(sftp, remoteConfigPath)
      const next = installOrcaStatusContent(existing)
      if (next.content === null) {
        return {
          agent: 'hermes',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: `Could not parse remote Hermes config.yaml: ${next.detail ?? 'unknown error'}`
        }
      }
      await writeRemoteHome(sftp, `${remoteRoot}/.hermes`, existing, next.content)
      await installRemoteManagedProfiles(sftp, `${remoteRoot}/.hermes/profiles`)
      return {
        agent: 'hermes',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (error) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const parsed = readConfigFile(configPath)
    if (!parsed.ok) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath,
        managedHooksPresent: getPluginFilesState().managed,
        detail: `Could not parse Hermes config.yaml: ${parsed.detail}`
      }
    }
    const next = removeOrcaStatusContent(parsed.content)
    if (next.content === null) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath,
        managedHooksPresent: getPluginFilesState().managed,
        detail: `Could not update Hermes config.yaml: ${next.detail ?? 'unknown error'}`
      }
    }
    if (next.content !== parsed.content) {
      writeConfigFile(configPath, next.content)
    }
    const pluginDir = getPluginDir()
    if (getPluginFilesState(pluginDir).managed) {
      rmSync(pluginDir, { recursive: true, force: true })
    }
    updateManagedProfiles(removeOrcaStatusContent, (dir) =>
      rmSync(dir, { recursive: true, force: true })
    )
    return this.getStatus()
  }
}

export const hermesHookService = new HermesHookService()

export const _internals = {
  HERMES_PLUGIN_NAME,
  HERMES_EVENTS,
  getHermesHome,
  getPluginManifest,
  getPluginInitSource,
  parseHermesConfig,
  enablePlugin,
  disablePlugin,
  updateConfigContent
}
