import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SFTPWrapper } from 'ssh2'

import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  buildWindowsAgentHookCurlPostCommand,
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
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  applyManagedDshPatch,
  isDshPatchFileUnappendable,
  readManagedDshHooksConfigPath,
  removeManagedDshPatch
} from './dsh-home-patch'
import {
  buildDshManagedHooksFile,
  DSH_HOOK_EVENTS,
  getDshConfigPath,
  getDshManagedCommand,
  getDshManagedCommandMatcher,
  getDshManagedHooksPath,
  getDshManagedScriptPath,
  getDshRemoteConfigPath,
  getDshRemoteManagedCommand,
  getDshRemoteManagedHooksPath,
  readManagedDshHookEvents
} from './hook-settings'

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Restore DSH-scrubbed KEY/TOKEN variables before any guard or spool code reads them.
      'if not defined ORCA_PANE_KEY if defined ORCA_AGENT_PANE set "ORCA_PANE_KEY=%ORCA_AGENT_PANE%"',
      'if not defined ORCA_AGENT_LAUNCH_TOKEN if defined ORCA_AGENT_LAUNCH set "ORCA_AGENT_LAUNCH_TOKEN=%ORCA_AGENT_LAUNCH%"',
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookCurlPostCommand('dsh'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // DSH scrubs KEY/TOKEN variables; recover canonical names from the aliases set at spawn.
    ': "${ORCA_PANE_KEY:=${ORCA_AGENT_PANE:-}}"',
    ': "${ORCA_AGENT_LAUNCH_TOKEN:=${ORCA_AGENT_LAUNCH:-}}"',
    'export ORCA_PANE_KEY ORCA_AGENT_LAUNCH_TOKEN',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('dsh'),
    // Refresh endpoint credentials for PTYs that outlive an Orca restart.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    ...buildPosixAgentHookPostCommand('dsh').map((line, index, lines) =>
      index === lines.length - 1 ? `${line} >/dev/null 2>&1 || spool_hook_event` : line
    ),
    'exit 0',
    ''
  ].join('\n')
}

/** Distinguish absent files ('') from unreadable files (null). */
function readTextOrAbsent(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch (error) {
    return isDefinitiveAbsence(error) ? '' : null
  }
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function writePatchText(configPath: string, text: string): void {
  mkdirSync(dirname(configPath), { recursive: true })
  // Reuse atomic replacement and backups while preserving owner-only permissions.
  writeHooksJson(configPath, {}, { serialized: text, preserveMode: true })
}

const FLOW_STYLE_DETAIL =
  'The DSH home patch is a flow-style sequence ([…]); rewrite it as a block sequence (one `- ` entry per line) so Orca can add its hooks without breaking it'

function status(
  configPath: string,
  state: AgentHookInstallState,
  detail: string | null,
  managedHooksPresent = false
): AgentHookInstallStatus {
  return { agent: 'dsh', state, configPath, managedHooksPresent, detail }
}

function buildStatus(
  patchText: string,
  managedHooksPath: string,
  managedText: string | null,
  configPath: string
): AgentHookInstallStatus {
  if (managedText === null) {
    return status(configPath, 'error', 'Could not read Orca managed hooks file')
  }
  // Check refusal first: an absent managed pointer would otherwise hide the actionable error.
  if (isDshPatchFileUnappendable(patchText)) {
    return status(configPath, 'error', FLOW_STYLE_DETAIL)
  }
  const pointer = readManagedDshHooksConfigPath(patchText)
  if (pointer !== managedHooksPath) {
    return status(
      configPath,
      'not_installed',
      pointer === undefined
        ? null
        : `The Orca patch block points at ${pointer}, not the Orca managed hooks file`
    )
  }
  const present = readManagedDshHookEvents(
    parseJsonOrNull(managedText),
    getDshManagedCommandMatcher()
  )
  const missing = DSH_HOOK_EVENTS.filter((event) => !present.has(event))
  if (missing.length === 0) {
    return status(configPath, 'installed', null, true)
  }
  return present.size === 0
    ? status(configPath, 'not_installed', null)
    : status(configPath, 'partial', `Managed hook missing for events: ${missing.join(', ')}`, true)
}

/** DSH patch-layer and env-scrub constraints: docs/reference/dsh-harness-integration.md. */
export class DshHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getDshManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getDshConfigPath()
    const patchText = readTextOrAbsent(configPath)
    if (patchText === null) {
      return status(configPath, 'error', 'Could not read the DSH home patch file')
    }
    const managedHooksPath = getDshManagedHooksPath()
    return buildStatus(patchText, managedHooksPath, readTextOrAbsent(managedHooksPath), configPath)
  }

  install(): AgentHookInstallStatus {
    const configPath = getDshConfigPath()
    const patchText = readTextOrAbsent(configPath)
    if (patchText === null) {
      return status(configPath, 'error', 'Could not read the DSH home patch file')
    }
    const scriptPath = getDshManagedScriptPath()
    const managedHooksPath = getDshManagedHooksPath()
    // Publish dependencies before the patch layer so it cannot reference missing files.
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(
      managedHooksPath,
      { hooks: {} },
      { serialized: buildDshManagedHooksFile(getDshManagedCommand(scriptPath)) }
    )
    const nextText = applyManagedDshPatch(patchText, managedHooksPath)
    if (nextText === null) {
      return status(configPath, 'error', FLOW_STYLE_DETAIL)
    }
    if (nextText !== patchText) {
      writePatchText(configPath, nextText)
    }
    return this.getStatus()
  }

  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = getDshRemoteConfigPath(remoteHome)
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/dsh-hook.sh`
    const remoteManagedHooksPath = getDshRemoteManagedHooksPath(remoteHome)
    try {
      const body = (await readTextFileRemote(sftp, remoteConfigPath)) ?? ''
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeTextFileRemoteAtomic(
        sftp,
        remoteManagedHooksPath,
        buildDshManagedHooksFile(getDshRemoteManagedCommand(remoteScriptPath))
      )
      const nextText = applyManagedDshPatch(body, remoteManagedHooksPath)
      if (nextText === null) {
        return status(remoteConfigPath, 'error', FLOW_STYLE_DETAIL)
      }
      await writeTextFileRemoteAtomic(sftp, remoteConfigPath, nextText)
      return status(remoteConfigPath, 'installed', null, true)
    } catch (err) {
      return status(remoteConfigPath, 'error', err instanceof Error ? err.message : String(err))
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getDshConfigPath()
    const patchText = readTextOrAbsent(configPath)
    if (patchText === null) {
      return status(configPath, 'error', 'Could not read the DSH home patch file')
    }
    const { text: nextText, changed } = removeManagedDshPatch(patchText)
    if (changed) {
      writePatchText(configPath, nextText)
    }
    rmSync(getDshManagedHooksPath(), { force: true })
    return this.getStatus()
  }
}

export const dshHookService = new DshHookService()
