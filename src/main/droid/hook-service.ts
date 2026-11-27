import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type {
  AgentHookInstallState,
  AgentHookInstallStatus
} from '../../shared/agent-hook-listener/configuration/agent-hook-types'
import { buildWindowsAgentHookPostCommand } from '../agent-hooks/installation/commands/windows-agent-hook-post-command'
import { getSharedManagedScriptPath } from '../agent-hooks/installation/scripts/managed-hook-script-path'
import {
  isPlainObject,
  readHooksJson
} from '../agent-hooks/installation/configuration/hooks-json-read'
import { wrapPosixHookCommand } from '../agent-hooks/installation/commands/posix-hook-command'
import { writeHooksJson } from '../agent-hooks/installation/configuration/hooks-json-write'
import { writeManagedScript } from '../agent-hooks/installation/scripts/managed-hook-script-write'
import { wrapWindowsBatchHookCommand } from '../agent-hooks/installation/commands/windows-direct-cmd-hook-command'
import { refreshManagedScriptIfPresent } from '../agent-hooks/installation/scripts/managed-hook-script-refresh'
import {
  readHooksJsonRemoteWithRaw,
  writeHooksJsonRemote
} from '../agent-hooks/installation/configuration/hooks-json-remote'
import { writeManagedScriptRemote } from '../agent-hooks/installation/scripts/managed-script-write-remote'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines
} from '../agent-hooks/installation/scripts/hook-stdin-contract'
import { posixCurlCommand } from '../agent-hooks/installation/scripts/hook-post-command'
import { readManagedHookEventsFromJson } from '../agent-hooks/installation/configuration/managed-hooks-json-events'
import {
  DROID_EVENTS,
  hasManagedDroidHooks,
  readDroidHooksFile,
  readDroidHooksFileRemote,
  nextDroidHookEvents,
  type DroidHookEvents,
  type DroidHooksFile
} from './droid-hook-config-files'

function getFactoryDir(): string {
  return join(homedir(), '.factory')
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'droid-hook.cmd' : 'droid-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getManagedCommand(scriptPath: string): string {
  // Factory runs hooks through cmd.exe, where unquoted profile spaces split the path.
  return process.platform === 'win32'
    ? wrapWindowsBatchHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookPostCommand('droid'),
      'exit /b 0',
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('droid'),
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Bound stalled posts and keep large payloads on stdin to avoid EDR command-line alerts.
    `printf '%s' "$payload" | ${posixCurlCommand()} -sS -X POST "http://127.0.0.1:\${ORCA_AGENT_HOOK_PORT}/hook/droid" \\`,
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

function droidHookError(configPath: string, detail: string): AgentHookInstallStatus {
  return { agent: 'droid', state: 'error', configPath, managedHooksPresent: false, detail }
}

type DroidConfigFiles = {
  hooksFile: DroidHooksFile
  settingsPath: string
  settings: Record<string, unknown>
}

function readDroidConfigFiles(): DroidConfigFiles | AgentHookInstallStatus {
  const settingsPath = join(getFactoryDir(), 'settings.json')
  const settings = readHooksJson(settingsPath)
  if (!settings) {
    return droidHookError(settingsPath, 'Could not parse Factory settings.json')
  }
  return { hooksFile: readDroidHooksFile(getFactoryDir()), settingsPath, settings }
}

type DroidConfigUpdate = {
  /** Null maps mean the file must be left untouched on disk. */
  hooks: DroidHookEvents | null
  settingsHooks: DroidHookEvents | null
  /** The config as it reads after the update is written. */
  next: DroidConfigFiles
}

function nextDroidConfigFiles(
  files: DroidConfigFiles,
  scriptFileName: string,
  command: string | null
): DroidConfigUpdate {
  const { hooksFile, settings } = files
  const hooks = hooksFile.editable
    ? nextDroidHookEvents(hooksFile.events, scriptFileName, command, 'hooks')
    : null
  const settingsHooks = nextDroidHookEvents(settings.hooks, scriptFileName, command, 'settings')
  return {
    hooks,
    settingsHooks,
    next: {
      ...files,
      hooksFile: { ...hooksFile, events: hooks ?? hooksFile.events },
      settings: { ...settings, hooks: settingsHooks ?? settings.hooks }
    }
  }
}

function writeDroidConfigFiles(files: DroidConfigFiles, command: string | null): DroidConfigFiles {
  const { hooks, settingsHooks, next } = nextDroidConfigFiles(
    files,
    getManagedScriptFileName(),
    command
  )
  if (hooks) {
    writeHooksJson(files.hooksFile.path, hooks)
  }
  if (settingsHooks) {
    writeHooksJson(files.settingsPath, next.settings)
  }
  return next
}

// Names the hooks file when it hides an event Orca cannot add itself to.
function describeUneditableHooksFile(hooksFile: DroidHooksFile, missing: string[]): string | null {
  return !hooksFile.editable &&
    missing.some((eventName) => Object.hasOwn(hooksFile.events, eventName))
    ? `${hooksFile.path} has comments; Orca cannot edit it`
    : null
}

function buildStatus(
  { hooksFile, settingsPath, settings }: DroidConfigFiles,
  command: string,
  scriptFileName: string
): AgentHookInstallStatus {
  // Droid's merge: each hooks-file key replaces the same settings.json key.
  const effective: DroidHookEvents = {
    ...(isPlainObject(settings.hooks) ? settings.hooks : {}),
    ...hooksFile.events
  }
  const eventNames = DROID_EVENTS.map((event) => event.eventName)
  const present = readManagedHookEventsFromJson(
    { hooks: effective },
    eventNames,
    (hookCommand) => hookCommand === command
  )
  const missing = eventNames.filter((eventName) => !present.has(eventName))
  const presentCount = DROID_EVENTS.length - missing.length
  const hooksFileHasManagedHooks = hasManagedDroidHooks(hooksFile.events, scriptFileName)
  const settingsHasManagedHooks = hasManagedDroidHooks(settings.hooks, scriptFileName)
  // Droid reads hooks.hooksDisabled; the top-level key is a fallback for older Factory settings.
  const hooksDisabled = (effective.hooksDisabled ?? settings.hooksDisabled) === true
  let state: AgentHookInstallState
  let detail: string | null
  // Report hooksDisabled even for partial installs so reinstalling cannot appear to fix it.
  if (missing.length === 0 || presentCount === 0) {
    state = hooksDisabled ? 'partial' : missing.length === 0 ? 'installed' : 'not_installed'
    detail = hooksDisabled ? 'Droid hooks are disabled in Factory settings' : null
  } else {
    state = 'partial'
    detail = hooksDisabled
      ? `Droid hooks are disabled in Factory settings; managed hook missing for events: ${missing.join(', ')}`
      : `Managed hook missing for events: ${missing.join(', ')}`
  }
  const hooksFileProblem = describeUneditableHooksFile(hooksFile, missing)
  if (hooksFileProblem) {
    detail = detail ? `${detail}; ${hooksFileProblem}` : hooksFileProblem
  }
  return {
    agent: 'droid',
    state,
    configPath: settingsPath,
    ...(hooksFileHasManagedHooks ? { additionalConfigPaths: [hooksFile.path] } : {}),
    managedHooksPresent: settingsHasManagedHooks || hooksFileHasManagedHooks,
    detail
  }
}

function buildLocalStatus(files: DroidConfigFiles): AgentHookInstallStatus {
  return buildStatus(files, getManagedCommand(getManagedScriptPath()), getManagedScriptFileName())
}

export class DroidHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const files = readDroidConfigFiles()
    return 'agent' in files ? files : buildLocalStatus(files)
  }

  install(): AgentHookInstallStatus {
    const files = readDroidConfigFiles()
    if ('agent' in files) {
      return files
    }
    const scriptPath = getManagedScriptPath()
    writeManagedScript(scriptPath, getManagedScript())
    return buildLocalStatus(writeDroidConfigFiles(files, getManagedCommand(scriptPath)))
  }

  // Remote installs always use POSIX scripts and paths, including from Windows clients.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const home = remoteHome.replace(/\/$/, '')
    const remoteFactoryDir = `${home}/.factory`
    const remoteSettingsPath = `${remoteFactoryDir}/settings.json`
    const remoteScriptPath = `${home}/.orca/agent-hooks/droid-hook.sh`
    try {
      const command = wrapPosixHookCommand(remoteScriptPath)
      // Publish the script before config so interrupted installs cannot reference a missing file.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))

      for (let attempt = 0; ; attempt++) {
        const hooksFile = await readDroidHooksFileRemote(sftp, remoteFactoryDir)
        const settingsSnapshot = await readHooksJsonRemoteWithRaw(sftp, remoteSettingsPath)
        if (!settingsSnapshot.config) {
          return droidHookError(remoteSettingsPath, 'Could not parse remote Factory settings.json')
        }

        const { hooks, settingsHooks, next } = nextDroidConfigFiles(
          { hooksFile, settingsPath: remoteSettingsPath, settings: settingsSnapshot.config },
          'droid-hook.sh',
          command
        )
        // A save after the read is kept; re-read and redo the merge on the user's revision.
        if (hooks) {
          const wroteHooks = await writeHooksJsonRemote(sftp, hooksFile.path, hooks, {
            computedFrom: hooksFile.raw
          })
          if (!wroteHooks) {
            if (attempt === 2) {
              return droidHookError(
                hooksFile.path,
                `${hooksFile.path} kept changing while Orca updated it`
              )
            }
            continue
          }
        }
        if (settingsHooks) {
          const wroteSettings = await writeHooksJsonRemote(
            sftp,
            remoteSettingsPath,
            next.settings,
            {
              computedFrom: settingsSnapshot.raw
            }
          )
          if (!wroteSettings) {
            if (attempt === 2) {
              return droidHookError(
                remoteSettingsPath,
                `${remoteSettingsPath} kept changing while Orca updated it`
              )
            }
            continue
          }
        }

        return buildStatus(next, command, 'droid-hook.sh')
      }
    } catch (err) {
      return droidHookError(remoteSettingsPath, err instanceof Error ? err.message : String(err))
    }
  }

  remove(): AgentHookInstallStatus {
    const files = readDroidConfigFiles()
    if ('agent' in files) {
      return files
    }
    return buildLocalStatus(writeDroidConfigFiles(files, null))
  }
}

export const droidHookService = new DroidHookService()
