import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix as pathPosix } from 'node:path'
import type { SFTPWrapper } from 'ssh2'

import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  buildWindowsAgentHookCurlPostCommand,
  isPlainObject,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import {
  listRemoteDirectory,
  readTextFileRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  applyManagedKiroHooks,
  getKiroAgentsDir,
  getKiroManagedCommand,
  getKiroManagedCommandMatcher,
  getKiroManagedScriptPath,
  getKiroRemoteAgentsDir,
  getKiroRemoteManagedCommand,
  isKiroAgentConfigFileName,
  isKiroHooksConfigSupported,
  KIRO_HOOK_EVENTS,
  readManagedKiroHookEvents,
  removeManagedKiroHooks,
  serializeKiroAgentConfig
} from './hook-settings'
import { getKiroRemoteStandaloneHooksFilePath } from './standalone-hook-settings'
import {
  getKiroStandaloneHooksStatus,
  installKiroStandaloneHooks,
  installKiroStandaloneHooksRemote,
  removeKiroStandaloneHooks,
  withKiroStandaloneHooksStatus
} from './standalone-hooks'

// Why: hook stdout from agentSpawn/userPromptSubmit is injected into Kiro's model context,
// so every path below must stay silent.
function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookCurlPostCommand('kiro'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('kiro'),
    // Why: the endpoint file holds the live port/token; a PTY that outlived an Orca
    // restart carries stale env, so source it to reach the new server.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    ...buildPosixAgentHookPostCommand('kiro').map((line, index, lines) =>
      index === lines.length - 1 ? `${line} >/dev/null 2>&1 || spool_hook_event` : line
    ),
    'exit 0',
    ''
  ].join('\n')
}

function noAgentsDetail(agentsDir: string): string {
  return `No custom Kiro agents in ${agentsDir}. Kiro's built-in default agent cannot carry hooks; create one with \`kiro-cli agent create\` and make it the default so Orca can track Kiro's status`
}

type AgentFileRead =
  | { fileName: string; config: Record<string, unknown> }
  | { fileName: string; error: string }

function status(
  configPath: string,
  state: AgentHookInstallState,
  detail: string | null,
  managedHooksPresent = false
): AgentHookInstallStatus {
  return { agent: 'kiro', state, configPath, managedHooksPresent, detail }
}

function parseAgentConfig(fileName: string, text: string): AgentFileRead {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isPlainObject(parsed)) {
      return { fileName, error: 'not a JSON object' }
    }
    if (!isKiroHooksConfigSupported(parsed)) {
      return { fileName, error: 'unsupported hooks structure' }
    }
    return { fileName, config: parsed }
  } catch {
    return { fileName, error: 'not valid JSON' }
  }
}

/** null when the directory itself cannot be read; [] when it does not exist. */
function readLocalAgentFiles(agentsDir: string): AgentFileRead[] | null {
  let fileNames: string[]
  try {
    fileNames = readdirSync(agentsDir).filter(isKiroAgentConfigFileName).sort()
  } catch (error) {
    return isDefinitiveAbsence(error) ? [] : null
  }
  return fileNames.map((fileName) => {
    try {
      return parseAgentConfig(fileName, readFileSync(join(agentsDir, fileName), 'utf-8'))
    } catch {
      return { fileName, error: 'could not be read' }
    }
  })
}

function buildStatus(agentsDir: string, files: AgentFileRead[]): AgentHookInstallStatus {
  if (files.length === 0) {
    return status(agentsDir, 'not_installed', noAgentsDetail(agentsDir))
  }
  const isManaged = getKiroManagedCommandMatcher()
  const problems: string[] = []
  let managedHooksPresent = false
  let complete = 0
  for (const file of files) {
    if ('error' in file) {
      problems.push(`${file.fileName} is ${file.error}`)
      continue
    }
    const present = readManagedKiroHookEvents(file.config, isManaged)
    managedHooksPresent ||= present.size > 0
    const missing = KIRO_HOOK_EVENTS.filter((event) => !present.has(event))
    if (missing.length === 0) {
      complete += 1
    } else if (present.size > 0) {
      problems.push(`${file.fileName} is missing managed hooks for: ${missing.join(', ')}`)
    } else {
      problems.push(`${file.fileName} has no Orca hooks`)
    }
  }
  if (problems.length === 0) {
    return status(agentsDir, 'installed', null, true)
  }
  if (!managedHooksPresent && complete === 0) {
    return status(
      agentsDir,
      files.some((file) => 'error' in file) ? 'error' : 'not_installed',
      problems.join('; ')
    )
  }
  return status(agentsDir, 'partial', problems.join('; '), managedHooksPresent)
}

/**
 * Installs Orca's status hooks into every global Kiro agent config (the default engine) and
 * into the global standalone hooks file the opt-in V3 engine (`--v3`) loads instead.
 */
export class KiroHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getKiroManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const agentsDir = getKiroAgentsDir()
    const files = readLocalAgentFiles(agentsDir)
    const standalone = getKiroStandaloneHooksStatus()
    if (files === null) {
      return withKiroStandaloneHooksStatus(
        status(agentsDir, 'error', 'Could not read the Kiro agents directory'),
        standalone
      )
    }
    const result = buildStatus(agentsDir, files)
    return withKiroStandaloneHooksStatus(
      result.managedHooksPresent && !existsSync(getKiroManagedScriptPath())
        ? { ...result, state: 'partial', detail: 'Managed hook script missing' }
        : result,
      standalone
    )
  }

  install(): AgentHookInstallStatus {
    const agentsDir = getKiroAgentsDir()
    const files = readLocalAgentFiles(agentsDir)
    const scriptPath = getKiroManagedScriptPath()
    // Write the script first so no hooks file ever points at a missing file.
    writeManagedScript(scriptPath, getManagedScript())
    const command = getKiroManagedCommand(scriptPath)
    const isManaged = getKiroManagedCommandMatcher()
    for (const file of files ?? []) {
      if ('error' in file) {
        continue
      }
      const next = applyManagedKiroHooks(file.config, command, isManaged)
      writeHooksJson(join(agentsDir, file.fileName), next, {
        serialized: serializeKiroAgentConfig(next),
        preserveMode: true
      })
    }
    // Why: V3 loads this file for every agent, the built-in default included, so it goes in
    // even when there is no custom agent (or agents directory) to patch.
    installKiroStandaloneHooks(command)
    return this.getStatus()
  }

  /** Install on an SSH execution host, where Kiro runs hooks through sh. */
  async installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    kiroHomeDir?: string
  ): Promise<AgentHookInstallStatus> {
    const agentsDir = getKiroRemoteAgentsDir(remoteHome, kiroHomeDir)
    const scriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/kiro-hook.sh`
    try {
      // Write the script first so no hooks file ever points at a missing file.
      await writeManagedScriptRemote(sftp, scriptPath, getManagedScript('posix'))
      const command = getKiroRemoteManagedCommand(scriptPath)
      // Why: as locally, V3's global file covers the built-in default agent; it lives under
      // the remote home because V3 ignores KIRO_HOME, which only relocates V2 agents.
      const standalone = await installKiroStandaloneHooksRemote(
        sftp,
        getKiroRemoteStandaloneHooksFilePath(remoteHome),
        command
      )
      const fileNames = ((await listRemoteDirectory(sftp, agentsDir)) ?? [])
        .filter(isKiroAgentConfigFileName)
        .sort()
      if (fileNames.length === 0) {
        return withKiroStandaloneHooksStatus(
          status(agentsDir, 'not_installed', noAgentsDetail(agentsDir)),
          standalone
        )
      }
      const isManaged = getKiroManagedCommandMatcher()
      const files: AgentFileRead[] = []
      for (const fileName of fileNames) {
        const path = pathPosix.join(agentsDir, fileName)
        const text = await readTextFileRemote(sftp, path)
        // Deleted after the listing: same status as the local unreadable-file path.
        const file: AgentFileRead =
          text === null
            ? { fileName, error: 'could not be read' }
            : parseAgentConfig(fileName, text)
        if ('error' in file) {
          files.push(file)
          continue
        }
        const next = applyManagedKiroHooks(file.config, command, isManaged)
        await writeTextFileRemoteAtomic(sftp, path, serializeKiroAgentConfig(next))
        files.push({ fileName, config: next })
      }
      return withKiroStandaloneHooksStatus(buildStatus(agentsDir, files), standalone)
    } catch (err) {
      return status(agentsDir, 'error', err instanceof Error ? err.message : String(err))
    }
  }

  remove(): AgentHookInstallStatus {
    removeKiroStandaloneHooks()
    const agentsDir = getKiroAgentsDir()
    const files = readLocalAgentFiles(agentsDir)
    if (files === null) {
      return this.getStatus()
    }
    const isManaged = getKiroManagedCommandMatcher()
    for (const file of files) {
      if ('error' in file) {
        continue
      }
      const next = removeManagedKiroHooks(file.config, isManaged)
      if (next !== file.config) {
        writeHooksJson(join(agentsDir, file.fileName), next, {
          serialized: serializeKiroAgentConfig(next),
          preserveMode: true
        })
      }
    }
    return this.getStatus()
  }
}

export const kiroHookService = new KiroHookService()
