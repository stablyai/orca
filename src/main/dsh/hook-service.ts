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
      // Why: same scrub as POSIX — restore the canonical names from their aliases first.
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
    // Why first: DSH's shell executor drops every env var whose NAME contains KEY, TOKEN,
    // SECRET or PASSWORD before the hook starts, which takes ORCA_PANE_KEY and
    // ORCA_AGENT_LAUNCH_TOKEN with it. Orca mirrors both onto scrub-safe aliases at spawn
    // (see agent-hook-scrub-safe-env.ts); restore the canonical names from them so every
    // line below — including the shared spool and post builders — is unchanged.
    ': "${ORCA_PANE_KEY:=${ORCA_AGENT_PANE:-}}"',
    ': "${ORCA_AGENT_LAUNCH_TOKEN:=${ORCA_AGENT_LAUNCH:-}}"',
    'export ORCA_PANE_KEY ORCA_AGENT_LAUNCH_TOKEN',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('dsh'),
    // Why: the endpoint file holds the live port/token; a PTY that outlived an Orca
    // restart carries stale env, so source it to reach the new server.
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

/** '' when the file is absent (both are created lazily), null when it exists but cannot be read. */
function readTextOrAbsent(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch (error) {
    return isDefinitiveAbsence(error) ? '' : null
  }
}

/** null for anything that is not parseable JSON; the caller reads that as "no events". */
function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function writePatchText(configPath: string, text: string): void {
  mkdirSync(dirname(configPath), { recursive: true })
  // Why writeHooksJson: it owns the temp+rename and the rolling .bak this file needs too.
  // Why preserveMode: an owner-only patch file must not widen to the umask default on rewrite.
  writeHooksJson(configPath, {}, { serialized: text, preserveMode: true })
}

/** Why one constant: status has to say exactly what install said, on every later read. */
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
  // Why before the pointer check: a refused file carries no managed region, so the pointer
  // path would report a bare `not_installed` and drop the one detail that says why.
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
  // Why the split: nothing present is an uninstalled agent; some present is a broken install,
  // and naming the gap is the only way a user can tell those apart.
  return present.size === 0
    ? status(configPath, 'not_installed', null)
    : status(configPath, 'partial', `Managed hook missing for events: ${missing.join(', ')}`, true)
}

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
    // Write the script and the managed hooks file first so the patch layer never points at
    // files that do not exist yet — a bridge that cannot read its config runs no hooks.
    writeManagedScript(scriptPath, getManagedScript())
    writeHooksJson(
      managedHooksPath,
      { hooks: {} },
      { serialized: buildDshManagedHooksFile(getDshManagedCommand(scriptPath)) }
    )
    const nextText = applyManagedDshPatch(patchText, managedHooksPath)
    if (nextText === null) {
      // Why refuse rather than edit: YAML forbids a block entry after a flow sequence, so
      // appending here would leave DSH unable to parse the user's own patch layer either.
      return status(configPath, 'error', FLOW_STYLE_DETAIL)
    }
    if (nextText !== patchText) {
      writePatchText(configPath, nextText)
    }
    return this.getStatus()
  }

  /** Install on an SSH execution host, where DSH's shell contract is always POSIX. */
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
    // Why force: the file is Orca's own and may already be gone; its absence is the goal.
    rmSync(getDshManagedHooksPath(), { force: true })
    return this.getStatus()
  }
}

export const dshHookService = new DshHookService()
