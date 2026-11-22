import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type {
  AgentHookInstallState,
  AgentHookInstallStatus
} from '../../shared/agent-hook-listener/configuration/agent-hook-types'
import { getSharedManagedScriptPath } from '../agent-hooks/installation/scripts/managed-hook-script-path'
import {
  parseHooksJsonText,
  readHooksJson
} from '../agent-hooks/installation/configuration/hooks-json-read'
import {
  findOutdatedManagedEvents,
  type OutdatedManagedEvents
} from '../agent-hooks/installation/configuration/managed-hooks-json-outdated-events'
import { wrapPosixHookCommand } from '../agent-hooks/installation/commands/posix-hook-command'
import { writeHooksJson } from '../agent-hooks/installation/configuration/hooks-json-write'
import { writeManagedScript } from '../agent-hooks/installation/scripts/managed-hook-script-write'
import type { HookDefinition } from '../agent-hooks/installation/configuration/hook-config-schema'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote
} from '../agent-hooks/installation/configuration/hooks-json-remote'
import { writeManagedScriptRemote } from '../agent-hooks/installation/scripts/managed-script-write-remote'
import { wrapWindowsBatchHookCommand } from '../agent-hooks/installation/commands/windows-direct-cmd-hook-command'
import { WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT } from './windows-hook-json-post'
import { WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME } from '../agent-hooks/installation/commands/windows-native-hook-executable'
import { publishBundledWindowsNativeHookExecutable } from '../agent-hooks/installation/scripts/windows-native-hook-publish'
import {
  restoreManagedScript,
  refreshManagedScriptIfPresent,
  scriptStillExists
} from '../agent-hooks/installation/scripts/managed-hook-script-refresh'
import { ANTIGRAVITY_EVENTS, getAntigravityNoOpStdout, type AntigravityEvent } from './hook-events'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'
import { HOOK_PARENT_CAPTURE } from '../agent-hooks/installation/scripts/hook-process-capture'
import { getManagedScript, getWindowsWrapperScript } from './hook-script'
import {
  buildInstalledConfig,
  bundleHasStaleManagedCommand,
  createAntigravityManagedCommandMatcher,
  getBundle,
  hasManagedCommand,
  removeInstalledConfig
} from './hooks-json-bundle'

function getConfigPath(): string {
  return join(homedir(), '.gemini', 'config', 'hooks.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'antigravity-hook.cmd' : 'antigravity-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getWindowsWrapperScriptPath(event: AntigravityEvent): string {
  return getSharedManagedScriptPath(event.windowsWrapperFileName)
}

function getPosixManagedCommand(scriptPath: string, event: AntigravityEvent): string {
  const command = wrapPosixHookCommand(
    scriptPath,
    { ORCA_ANTIGRAVITY_EVENT: event.eventName },
    { fallbackStdout: getAntigravityNoOpStdout(event.eventName), stdinMayStayOpen: true }
  )
  // ACP hosts tokenize the command into argv; the shell must be the executable, not `if`.
  return `/bin/sh -c ${quotePosixShell(`${HOOK_PARENT_CAPTURE}${command}`)}`
}

function getManagedCommand(scriptPath: string, event: AntigravityEvent): string {
  if (process.platform === 'win32') {
    return wrapWindowsBatchHookCommand(getWindowsWrapperScriptPath(event))
  }
  return getPosixManagedCommand(scriptPath, event)
}

async function scanManagedEntries(
  scriptPath: string
): Promise<OutdatedManagedEvents<AntigravityEvent>> {
  // A missing or unreadable file has no Orca entries to repair.
  const raw = await readFile(getConfigPath(), 'utf8').catch(() => null)
  const config = raw === null ? null : parseHooksJsonText(raw)
  return findOutdatedManagedEvents(
    config ? getBundle(config) : {},
    ANTIGRAVITY_EVENTS,
    (event) => event.eventName,
    createAntigravityManagedCommandMatcher(),
    (definition, event) => hasManagedCommand([definition], getManagedCommand(scriptPath, event))
  )
}

export class AntigravityHookService {
  private getWindowsRuntimePath = (): string => process.execPath

  setWindowsRuntimePathProvider(provider: () => string): void {
    this.getWindowsRuntimePath = provider
  }

  async refreshManagedScripts(): Promise<void> {
    const runtimePath = process.platform === 'win32' ? this.getWindowsRuntimePath() : undefined
    if (process.platform === 'win32' && (await scriptStillExists(getManagedScriptPath()))) {
      await restoreManagedScript(
        getSharedManagedScriptPath('antigravity-hook-post.cjs'),
        WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT
      )
      // Installs from before #41298 lack the native reader the refreshed core prefers.
      await publishBundledWindowsNativeHookExecutable(
        getSharedManagedScriptPath(WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME),
        { createMissing: true }
      )
      for (const event of ANTIGRAVITY_EVENTS) {
        await refreshManagedScriptIfPresent(
          getWindowsWrapperScriptPath(event),
          getWindowsWrapperScript(event.eventName)
        )
      }
    }
    await refreshManagedScriptIfPresent(
      getManagedScriptPath(),
      getManagedScript('local', runtimePath)
    )
    // agy and the desktop app run these entries without the CLI that gates install(); update only what Orca owns.
    const scan = await scanManagedEntries(getManagedScriptPath())
    if (scan.outdated) {
      this.install(scan.events, { onlyOwnedEvents: true })
    }
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    const bundle = getBundle(config)
    const isManagedCommand = createAntigravityManagedCommandMatcher()
    const currentCommands = new Set(
      ANTIGRAVITY_EVENTS.map((event) => getManagedCommand(scriptPath, event))
    )
    const staleManagedPresent = bundleHasStaleManagedCommand(
      bundle,
      isManagedCommand,
      currentCommands
    )
    const missing: string[] = []
    let presentCount = 0
    for (const event of ANTIGRAVITY_EVENTS) {
      const definitions = Array.isArray(bundle[event.eventName])
        ? (bundle[event.eventName] as HookDefinition[])
        : []
      if (hasManagedCommand(definitions, getManagedCommand(scriptPath, event))) {
        presentCount += 1
      } else {
        missing.push(event.eventName)
      }
    }

    const managedHooksPresent = presentCount > 0 || staleManagedPresent
    let state: AgentHookInstallState
    let detail: string | null
    if (missing.length === 0 && !staleManagedPresent) {
      state = 'installed'
      detail = null
    } else if (presentCount === 0 && !staleManagedPresent) {
      state = 'not_installed'
      detail = null
    } else {
      state = 'partial'
      detail =
        missing.length > 0
          ? `Managed hook missing for events: ${missing.join(', ')}`
          : 'Stale managed hook entries need cleanup'
    }
    return { agent: 'antigravity', state, configPath, managedHooksPresent, detail }
  }

  install(
    events: readonly AntigravityEvent[] = ANTIGRAVITY_EVENTS,
    options: { onlyOwnedEvents?: boolean } = {}
  ): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    buildInstalledConfig(
      config,
      (event) => getManagedCommand(scriptPath, event),
      createAntigravityManagedCommandMatcher(),
      { events, onlyOwnedEvents: options.onlyOwnedEvents }
    )
    const runtimePath = process.platform === 'win32' ? this.getWindowsRuntimePath() : undefined
    if (process.platform === 'win32') {
      writeManagedScript(
        getSharedManagedScriptPath('antigravity-hook-post.cjs'),
        WINDOWS_ANTIGRAVITY_JSON_POST_SCRIPT
      )
      // Off the main thread's sync path; until it lands the core uses the Node reader.
      void publishBundledWindowsNativeHookExecutable(
        getSharedManagedScriptPath(WINDOWS_NATIVE_HOOK_EXECUTABLE_NAME),
        { createMissing: true }
      )
    }
    writeManagedScript(scriptPath, getManagedScript('local', runtimePath))
    if (process.platform === 'win32') {
      // Event wrappers avoid nested quoting in cmd.exe hook commands.
      for (const event of ANTIGRAVITY_EVENTS) {
        writeManagedScript(
          getWindowsWrapperScriptPath(event),
          getWindowsWrapperScript(event.eventName)
        )
      }
    }
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const remoteConfigPath = `${home}/.gemini/config/hooks.json`
    const remoteScriptPath = `${home}/.orca/agent-hooks/antigravity-hook.sh`
    try {
      const config = await readHooksJsonRemote(sftp, remoteConfigPath)
      if (!config) {
        return {
          agent: 'antigravity',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote Antigravity hooks.json'
        }
      }

      buildInstalledConfig(
        config,
        (event) => getPosixManagedCommand(remoteScriptPath, event),
        createAntigravityManagedCommandMatcher()
      )
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, remoteConfigPath, config)

      return {
        agent: 'antigravity',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'antigravity',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Antigravity hooks.json'
      }
    }

    removeInstalledConfig(config)
    writeHooksJson(configPath, config)
    return this.getStatus()
  }
}

export const antigravityHookService = new AntigravityHookService()
