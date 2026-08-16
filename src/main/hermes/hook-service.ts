import { rmSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'

import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  readTextFileRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import type { HermesConfig } from './hermes-config-yaml'
import {
  disablePlugin,
  enablePlugin,
  getConfigEnablement,
  parseHermesConfig,
  updateConfigContent
} from './hermes-config-yaml'
import {
  getConfigPath,
  getHermesHome,
  getPluginDir,
  getPluginFilesState,
  readConfigFile,
  writeConfigFile,
  writePluginFiles
} from './hermes-home-filesystem'
import {
  HERMES_EVENTS,
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

    writePluginFiles()
    writeConfigFile(configPath, enablePlugin(parsed.config))
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteRoot = stripTrailingSlash(remoteHome)
    const remoteConfigPath = `${remoteRoot}/.hermes/config.yaml`
    const remotePluginDir = `${remoteRoot}/.hermes/plugins/${HERMES_PLUGIN_NAME}`
    try {
      const existing = await readTextFileRemote(sftp, remoteConfigPath)
      const next = updateConfigContent(existing, enablePlugin)
      if (next.content === null) {
        return {
          agent: 'hermes',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: `Could not parse remote Hermes config.yaml: ${next.detail ?? 'unknown error'}`
        }
      }
      await writeTextFileRemoteAtomic(sftp, `${remotePluginDir}/plugin.yaml`, getPluginManifest())
      await writeTextFileRemoteAtomic(sftp, `${remotePluginDir}/__init__.py`, getPluginInitSource())
      await writeTextFileRemoteAtomic(sftp, remoteConfigPath, next.content)
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
    const pluginDir = getPluginDir()
    if (getPluginFilesState(pluginDir).managed) {
      rmSync(pluginDir, { recursive: true, force: true })
    }
    writeConfigFile(configPath, disablePlugin(parsed.config))
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
