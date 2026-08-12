import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  buildWindowsAgentHookPostCommand,
  getSharedManagedScriptPath,
  readHooksJson,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  writeHooksJson,
  writeManagedScript,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  readHooksJsonRemote,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import {
  buildPosixHookPayloadCapture,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  applyManagedZcodeHooks,
  isZcodeHooksEnabled,
  readManagedZcodeHookEvents,
  removeManagedZcodeHooks,
  ZCODE_HOOK_EVENTS,
  type ZcodeConfig
} from './zcode-hook-config'

function getConfigPath(): string {
  return join(homedir(), '.zcode', 'cli', 'config.json')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'zcode-hook.cmd' : 'zcode-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getManagedCommand(scriptPath: string): string {
  return process.platform === 'win32'
    ? wrapWindowsHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookPostCommand('zcode'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/zcode" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

function asZcodeConfig(config: ReturnType<typeof readHooksJson>): ZcodeConfig | null {
  return config as ZcodeConfig | null
}

function asHooksConfig(config: ZcodeConfig): HooksConfig {
  return config as HooksConfig
}

function buildStatus(
  present: Set<string>,
  configPath: string,
  hooksEnabled: boolean
): AgentHookInstallStatus {
  const missing = ZCODE_HOOK_EVENTS.filter((event) => !present.has(event))
  let state: AgentHookInstallState
  let detail: string | null
  if (missing.length === 0 && hooksEnabled) {
    state = 'installed'
    detail = null
  } else if (present.size === 0) {
    state = 'not_installed'
    detail = null
  } else {
    state = 'partial'
    detail = hooksEnabled
      ? `Managed hook missing for events: ${missing.join(', ')}`
      : 'ZCode hooks are disabled (hooks.enabled is not true)'
  }
  return { agent: 'zcode', state, configPath, managedHooksPresent: present.size > 0, detail }
}

export class ZcodeHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = asZcodeConfig(readHooksJson(configPath))
    if (!config) {
      return {
        agent: 'zcode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse ZCode cli/config.json'
      }
    }
    return buildStatus(
      readManagedZcodeHookEvents(config, getManagedCommand(getManagedScriptPath())),
      configPath,
      isZcodeHooksEnabled(config)
    )
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = asZcodeConfig(readHooksJson(configPath))
    if (!config) {
      return {
        agent: 'zcode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse ZCode cli/config.json'
      }
    }
    const scriptPath = getManagedScriptPath()
    const next = applyManagedZcodeHooks(
      config,
      getManagedCommand(scriptPath),
      getManagedScriptFileName()
    )
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(configPath, asHooksConfig(next))
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const configPath = `${home}/.zcode/cli/config.json`
    const scriptPath = `${home}/.orca/agent-hooks/zcode-hook.sh`
    try {
      const config = asZcodeConfig(await readHooksJsonRemote(sftp, configPath))
      if (!config) {
        return {
          agent: 'zcode',
          state: 'error',
          configPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote ZCode cli/config.json'
        }
      }
      const next = applyManagedZcodeHooks(config, wrapPosixHookCommand(scriptPath), 'zcode-hook.sh')
      await writeManagedScriptRemote(sftp, scriptPath, getManagedScript('posix'))
      await writeHooksJsonRemote(sftp, configPath, asHooksConfig(next))
      return {
        agent: 'zcode',
        state: 'installed',
        configPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (error) {
      return {
        agent: 'zcode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: error instanceof Error ? error.message : String(error)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const config = asZcodeConfig(readHooksJson(configPath))
    if (!config) {
      return {
        agent: 'zcode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse ZCode cli/config.json'
      }
    }
    writeHooksJson(
      configPath,
      asHooksConfig(removeManagedZcodeHooks(config, getManagedScriptFileName()))
    )
    return this.getStatus()
  }
}

export const zcodeHookService = new ZcodeHookService()
