import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  resolveHermesHomeForLaunch,
  writeConfigFile,
  writePluginFiles
} from './hermes-home-filesystem'
import type { ManagedAgentHookScope } from '../agent-hooks/managed-agent-hook-registry'
import {
  HERMES_EVENTS,
  HERMES_PLUGIN_NAME,
  getPluginInitSource,
  getPluginManifest
} from './hermes-managed-plugin-source'

function buildStatus(
  configPath: string,
  config: HermesConfig,
  home: string
): AgentHookInstallStatus {
  const pluginFiles = getPluginFilesState(getPluginDir(home))
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

function remoteProfileHome(remoteHome: string, profile: string | undefined): string | null {
  const root = `${stripTrailingSlash(remoteHome)}/.hermes`
  if (!profile || profile === 'default') {
    return root
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(profile) ? `${root}/profiles/${profile}` : null
}

function isSafeProfileName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function discoverHermesHomes(root: string): string[] {
  const homes = [root]
  const profilesDir = join(root, 'profiles')
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && isSafeProfileName(entry.name)) {
        homes.push(join(profilesDir, entry.name))
      }
    }
  } catch {
    // A missing or unreadable profiles directory does not block root cleanup.
  }
  return homes
}

const knownHermesRoots = new Set<string>()
const HERMES_ROOT_INDEX = '.orca-managed-roots'
const HERMES_ROOT_MAX_LENGTH = 4096
const HERMES_ROOT_INDEX_MAX_BYTES = 16 * 1024

function rootIndexPath(): string {
  return join(getHermesHome(), HERMES_ROOT_INDEX)
}

function isSafeHermesRoot(root: string): boolean {
  return (
    root.length > 0 &&
    root.length <= HERMES_ROOT_MAX_LENGTH &&
    root.startsWith('/') &&
    Array.from(root).every((character) => {
      const code = character.charCodeAt(0)
      return code > 0x1f && code !== 0x7f
    })
  )
}

function readPersistedHermesRoots(): string[] {
  try {
    const source = readFileSync(rootIndexPath(), 'utf8')
    if (Buffer.byteLength(source, 'utf8') > HERMES_ROOT_INDEX_MAX_BYTES) {
      return []
    }
    return source.split(/\r?\n/).filter(isSafeHermesRoot)
  } catch {
    return []
  }
}

function rememberHermesRoot(root: string): void {
  if (!isSafeHermesRoot(root)) {
    return
  }
  knownHermesRoots.add(root)
  const defaultRoot = getHermesHome()
  if (root === defaultRoot) {
    return
  }
  const roots = [...new Set([...readPersistedHermesRoots(), root])].slice(0, 32)
  try {
    mkdirSync(defaultRoot, { recursive: true })
    writeFileSync(rootIndexPath(), `${roots.join('\n')}\n`, 'utf8')
  } catch {
    // Lifecycle bookkeeping must not block a launch or a settings action.
  }
}

export class HermesHookService {
  getStatus(options?: ManagedAgentHookScope): AgentHookInstallStatus {
    const home = resolveHermesHomeForLaunch(options?.env, options?.launchCommand)
    const configPath = getConfigPath(home)
    const parsed = readConfigFile(configPath)
    if (!parsed.ok) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath,
        managedHooksPresent: getPluginFilesState(getPluginDir(home)).managed,
        detail: `Could not parse Hermes config.yaml: ${parsed.detail}`
      }
    }
    return buildStatus(configPath, parsed.config, home)
  }

  install(options?: ManagedAgentHookScope): AgentHookInstallStatus {
    const home = resolveHermesHomeForLaunch(options?.env, options?.launchCommand)
    rememberHermesRoot(getHermesHome(options?.env))
    const configPath = getConfigPath(home)
    const parsed = readConfigFile(configPath)
    if (!parsed.ok) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath,
        managedHooksPresent: getPluginFilesState(getPluginDir(home)).managed,
        detail: `Could not parse Hermes config.yaml: ${parsed.detail}`
      }
    }

    writePluginFiles(getPluginDir(home))
    writeConfigFile(configPath, enablePlugin(parsed.config), parsed.source)
    return this.getStatus(options)
  }

  async installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    options?: { profile?: string }
  ): Promise<AgentHookInstallStatus> {
    const remoteHermesHome = remoteProfileHome(remoteHome, options?.profile)
    const remoteConfigPath = `${remoteHermesHome ?? `${stripTrailingSlash(remoteHome)}/.hermes`}/config.yaml`
    if (!remoteHermesHome) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: 'Invalid Hermes profile name'
      }
    }
    const remotePluginDir = `${remoteHermesHome}/plugins/${HERMES_PLUGIN_NAME}`
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

  remove(options?: ManagedAgentHookScope): AgentHookInstallStatus {
    const hasScope = Boolean(options?.env || options?.launchCommand)
    const root = getHermesHome(options?.env)
    if (hasScope) {
      rememberHermesRoot(root)
    }
    const homes = hasScope
      ? [resolveHermesHomeForLaunch(options?.env, options?.launchCommand)]
      : [...new Set([...knownHermesRoots, ...readPersistedHermesRoots(), root])].flatMap(
          discoverHermesHomes
        )
    let firstError: AgentHookInstallStatus | undefined
    let lastStatus: AgentHookInstallStatus | undefined
    for (const home of homes) {
      const status = this.removeHome(home)
      lastStatus = status
      if (status.state === 'error' && !firstError) {
        firstError = status
      }
    }
    if (!hasScope && !firstError) {
      knownHermesRoots.clear()
      try {
        rmSync(rootIndexPath(), { force: true })
      } catch {
        // Best-effort cleanup of the scope index.
      }
    }
    return firstError ?? lastStatus ?? this.getStatus(options)
  }

  private removeHome(home: string): AgentHookInstallStatus {
    const configPath = getConfigPath(home)
    const parsed = readConfigFile(configPath)
    if (!parsed.ok) {
      return {
        agent: 'hermes',
        state: 'error',
        configPath,
        managedHooksPresent: getPluginFilesState(getPluginDir(home)).managed,
        detail: `Could not parse Hermes config.yaml: ${parsed.detail}`
      }
    }
    const pluginDir = getPluginDir(home)
    if (getPluginFilesState(pluginDir).managed) {
      rmSync(pluginDir, { recursive: true, force: true })
    }
    if (existsSync(configPath)) {
      writeConfigFile(configPath, disablePlugin(parsed.config), parsed.source)
    }
    return this.getStatus({ env: { HERMES_HOME: home } })
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
