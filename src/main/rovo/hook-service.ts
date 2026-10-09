import { existsSync, readFileSync } from 'node:fs'
import { posix as pathPosix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  readTextFileRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines
} from '../agent-hooks/hook-stdin-contract'
import {
  applyManagedRovoHooks,
  readManagedRovoHookEvents,
  removeManagedRovoHooks,
  ROVO_HOOK_EVENTS
} from './rovo-hook-config-yaml'
import {
  getRovoConfigPath,
  getRovoManagedCommand,
  getRovoRemoteConfigPath,
  ROVO_HOOK_EMPTY_RESPONSE,
  ROVO_MANAGED_SCRIPT_FILE_NAME
} from './hook-settings'

const isManagedRovoCommand = createManagedCommandMatcher(ROVO_MANAGED_SCRIPT_FILE_NAME)

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(ROVO_MANAGED_SCRIPT_FILE_NAME)
}

function getManagedScript(): string {
  return [
    '#!/bin/sh',
    `printf '%s\\n' '${ROVO_HOOK_EMPTY_RESPONSE}'`,
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('rovo'),
    // Why: refresh PORT/TOKEN/ENV/VERSION so a PTY that survived an Orca restart reaches the live listener.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Why: form fields + `payload@-` keep paths and large tool payloads off the curl command line.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/rovo" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}

// '' when config.yml does not exist yet (Rovo creates it lazily).
function readConfigYaml(configPath: string): string {
  return existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
}

function errorStatus(configPath: string, detail: string): AgentHookInstallStatus {
  return { agent: 'rovo', state: 'error', configPath, managedHooksPresent: false, detail }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildStatus(present: Set<string>, configPath: string): AgentHookInstallStatus {
  const missing = ROVO_HOOK_EVENTS.filter((event) => !present.has(event))
  let state: AgentHookInstallState
  let detail: string | null = null
  if (missing.length === 0) {
    state = 'installed'
  } else if (present.size === 0) {
    state = 'not_installed'
  } else {
    state = 'partial'
    detail = `Managed hook missing for events: ${missing.join(', ')}`
  }
  return { agent: 'rovo', state, configPath, managedHooksPresent: present.size > 0, detail }
}

// Why: writeHooksJson owns the temp+rename write and rolling .bak; YAML text rides `serialized`.
function writeConfigYaml(configPath: string, text: string): void {
  writeHooksJson(configPath, {}, { serialized: text, preserveMode: true, defaultMode: 0o600 })
}

export class RovoHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getRovoConfigPath()
    try {
      const text = readConfigYaml(configPath)
      return buildStatus(readManagedRovoHookEvents(text, isManagedRovoCommand), configPath)
    } catch (error) {
      return errorStatus(configPath, errorDetail(error))
    }
  }

  install(): AgentHookInstallStatus {
    const configPath = getRovoConfigPath()
    if (process.platform === 'win32') {
      // Why: Rovo's Windows hook shell is unverified; a POSIX command under cmd.exe would fail and get disabled.
      return {
        agent: 'rovo',
        state: 'not_installed',
        configPath,
        managedHooksPresent: false,
        detail: 'Rovo status hooks are not supported on Windows yet'
      }
    }
    try {
      const text = readConfigYaml(configPath)
      const scriptPath = getManagedScriptPath()
      // Why: compute the edit first so an unparseable config.yml is never touched.
      const nextText = applyManagedRovoHooks(
        text,
        getRovoManagedCommand(scriptPath),
        isManagedRovoCommand
      )
      // Write the script first so config.yml never points at a missing script.
      writeManagedScript(scriptPath, getManagedScript())
      writeConfigYaml(configPath, nextText)
    } catch (error) {
      return errorStatus(configPath, errorDetail(error))
    }
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = getRovoRemoteConfigPath(remoteHome)
    const remoteScriptPath = pathPosix.join(
      remoteHome,
      '.orca',
      'agent-hooks',
      ROVO_MANAGED_SCRIPT_FILE_NAME
    )
    try {
      const text = (await readTextFileRemote(sftp, remoteConfigPath)) ?? ''
      const command = getRovoManagedCommand(remoteScriptPath)
      const nextText = applyManagedRovoHooks(text, command, isManagedRovoCommand)
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript())
      await writeTextFileRemoteAtomic(sftp, remoteConfigPath, nextText)
      return {
        agent: 'rovo',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (error) {
      return errorStatus(remoteConfigPath, errorDetail(error))
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getRovoConfigPath()
    try {
      const { text: nextText, changed } = removeManagedRovoHooks(
        readConfigYaml(configPath),
        isManagedRovoCommand
      )
      if (changed) {
        writeConfigYaml(configPath, nextText)
      }
    } catch (error) {
      return errorStatus(configPath, errorDetail(error))
    }
    return this.getStatus()
  }
}

export const rovoHookService = new RovoHookService()
