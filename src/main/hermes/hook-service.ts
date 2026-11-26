import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SFTPWrapper } from 'ssh2'

import type {
  AgentHookInstallState,
  AgentHookInstallStatus
} from '../../shared/agent-hook-listener/configuration/agent-hook-types'

import {
  type HermesConfig,
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
import { ensureHermesGatewayPluginCurrent } from './hermes-gateway-plugin-currency'
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
  HERMES_PLUGIN_NAME,
  getPluginInitSource,
  getPluginManifest
} from './hermes-managed-plugin-source'
import { installHermesHooksRemote } from './hermes-remote-hook-install'

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

/** A gateway already running keeps the plugin it loaded, so the one just written reaches its tools only after a reload. */
function reloadStaleGateway(home: string): void {
  void ensureHermesGatewayPluginCurrent(home).then(
    (state) => {
      if (state === 'stale') {
        console.warn(`[hermes] the gateway for ${home} still runs an older Orca plugin`)
      }
    },
    (error: unknown) => console.warn(`[hermes] could not check the gateway for ${home}:`, error)
  )
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
    const pluginFiles = getPluginFilesState()
    const parsed = readConfigFile(configPath)
    if (!parsed.ok) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath,
        managedHooksPresent: pluginFiles.managed,
        detail: `Could not parse Hermes config.yaml: ${parsed.detail}`
      }
    }

    if (pluginFiles.error) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: pluginFiles.detail
      }
    }
    if (pluginFiles.unmanaged) {
      return buildStatus(configPath, parsed.config)
    }

    const next = installOrcaStatusContent(parsed.content)
    if (next.content === null) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath,
        managedHooksPresent: pluginFiles.managed,
        detail: `Could not update Hermes config.yaml: ${next.detail ?? 'unknown error'}`
      }
    }
    writePluginFiles()
    if (next.content !== parsed.content) {
      writeConfigFile(configPath, next.content)
    }
    reloadStaleGateway(dirname(configPath))
    updateManagedProfiles(refreshProfileOrcaStatusContent, (pluginDir) => {
      writePluginFiles(pluginDir)
      reloadStaleGateway(dirname(dirname(pluginDir)))
    })
    return this.getStatus()
  }

  installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    return installHermesHooksRemote(sftp, remoteHome)
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
