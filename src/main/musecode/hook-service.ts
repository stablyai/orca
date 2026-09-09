import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SFTPWrapper } from 'ssh2'

// Why (parked): this service is complete and tested but NOT registered in
// managed-agent-hook-registry.ts / remote-managed-hook-installers.ts.
// 'musecode' stays present in AGENT_HOOK_TARGETS (presence probing only —
// no installer acts on the result) because AgentHookInstallStatus is typed
// over that list and forking status types would be worse.
// MuseCode runs hooks with a cleared environment (verified against muse 1.0.3:
// only HOME/PATH/LANG/USER/etc survive, no ORCA_* passthrough), so the
// managed script cannot learn ORCA_PANE_KEY and its events cannot be
// attributed to a pane — auto-installing now would add per-event curl/spool
// overhead for zero status benefit. Register once pane attribution is solved
// (upstream env allowlist, or PID-ancestry attribution in the hook server).
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { writeManagedScript, type HooksConfig } from '../agent-hooks/installer-utils'
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
import { buildPosixAgentHookPostCommand } from '../agent-hooks/hook-post-command'
import {
  buildMusecodeManagedHooksFile,
  getMusecodeConfigPath,
  getMusecodeManagedCommand,
  getMusecodeManagedCommandMatcher,
  getMusecodeManagedHooksPath,
  getMusecodeManagedScriptPath,
  getMusecodeRemoteConfigPath,
  getMusecodeRemoteManagedCommand,
  getMusecodeRemoteManagedHooksPath,
  MUSECODE_HOOK_EVENTS,
  readManagedMusecodeHookEvents
} from './hook-settings'
import {
  parseMusecodeSettingsText,
  readMusecodeSettingsSource,
  serializeMusecodeSettings
} from './hook-config-json'

// Always a POSIX `.sh` script: muse runs hook commands through sh (verified
// against muse 1.0.3), and the CLI has no native Windows build (WSL2 only),
// so a single curl-based script body works on every platform.
const MANAGED_SCRIPT_FILE_NAME = 'musecode-hook.sh'

function getManagedScript(): string {
  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('musecode'),
    // Why: endpoint file holds the live port/token; PTYs that outlive an Orca restart carry stale env, so source it to reach the new server (else PTY env).
    // Why: silence the `.` builtin (2>/dev/null + `|| :`) so a TOCTOU race can't leak shell parse errors into agent transcripts (fail-open).
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Why: redirect on `fi` covers the whole if-statement (both transport branches); `|| spool` keeps the fail-open spool fallback.
    ...buildPosixAgentHookPostCommand('musecode').map((line, index, lines) =>
      index === lines.length - 1 ? `${line} >/dev/null 2>&1 || spool_hook_event` : line
    ),
    'exit 0',
    ''
  ].join('\n')
}

function readManagedHooksFile(managedHooksPath: string): string | null {
  if (!existsSync(managedHooksPath)) {
    return ''
  }
  try {
    return readFileSync(managedHooksPath, 'utf-8')
  } catch {
    return null
  }
}

function writeTextFileAtomic(filePath: string, text: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, text, 'utf-8')
}

function buildStatus(
  pointer: string | undefined,
  managedHooksPath: string,
  managedText: string | null,
  configPath: string
): AgentHookInstallStatus {
  const base = { agent: 'musecode' as const, configPath }
  if (managedText === null) {
    return {
      ...base,
      state: 'error',
      managedHooksPresent: false,
      detail: 'Could not read Orca managed hooks file'
    }
  }
  if (pointer !== managedHooksPath) {
    return {
      ...base,
      state: 'not_installed',
      managedHooksPresent: false,
      detail:
        pointer === undefined
          ? null
          : `managed_hooks_path points at ${pointer}, not the Orca managed hooks file`
    }
  }
  let parsed: HooksConfig | null = null
  try {
    parsed = JSON.parse(managedText) as HooksConfig
  } catch {
    parsed = null
  }
  const present = readManagedMusecodeHookEvents(parsed, getMusecodeManagedCommandMatcher())
  const missing = MUSECODE_HOOK_EVENTS.filter((event) => !present.has(event))
  let state: AgentHookInstallState
  let detail: string | null
  if (missing.length === 0) {
    state = 'installed'
    detail = null
  } else if (present.size === 0) {
    state = 'not_installed'
    detail = null
  } else {
    state = 'partial'
    detail = `Managed hook missing for events: ${missing.join(', ')}`
  }
  return { ...base, state, managedHooksPresent: present.size > 0, detail }
}

export class MusecodeHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getMusecodeManagedScriptPath(), getManagedScript())
    const managedHooksPath = getMusecodeManagedHooksPath()
    if (existsSync(managedHooksPath)) {
      const command = getMusecodeManagedCommand(getMusecodeManagedScriptPath())
      writeTextFileAtomic(managedHooksPath, buildMusecodeManagedHooksFile(command))
    }
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getMusecodeConfigPath()
    const managedHooksPath = getMusecodeManagedHooksPath()
    const source = readMusecodeSettingsSource(configPath)
    if (!source) {
      return {
        agent: 'musecode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read MuseCode settings.json'
      }
    }
    const pointer =
      typeof source.config.managed_hooks_path === 'string'
        ? source.config.managed_hooks_path
        : undefined
    return buildStatus(
      pointer,
      managedHooksPath,
      readManagedHooksFile(managedHooksPath),
      configPath
    )
  }

  install(): AgentHookInstallStatus {
    const configPath = getMusecodeConfigPath()
    const managedHooksPath = getMusecodeManagedHooksPath()
    const source = readMusecodeSettingsSource(configPath)
    if (!source) {
      return {
        agent: 'musecode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read MuseCode settings.json'
      }
    }
    const scriptPath = getMusecodeManagedScriptPath()
    const command = getMusecodeManagedCommand(scriptPath)
    // Write the script and managed hooks file first so settings.json never points at missing files.
    writeManagedScript(scriptPath, getManagedScript())
    writeTextFileAtomic(managedHooksPath, buildMusecodeManagedHooksFile(command))
    const nextText = serializeMusecodeSettings(source.text, managedHooksPath)
    if (source.text !== nextText) {
      writeTextFileAtomic(configPath, nextText)
    }
    return this.getStatus()
  }

  // Why: install the MuseCode hook on a remote box over SFTP, mirroring the
  // local install. POSIX-only by design (muse has no native Windows build).
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = getMusecodeRemoteConfigPath(remoteHome)
    const remoteScriptPath = `${remoteHome.replace(/\/$/, '')}/.orca/agent-hooks/${MANAGED_SCRIPT_FILE_NAME}`
    const remoteManagedHooksPath = getMusecodeRemoteManagedHooksPath(remoteHome)
    try {
      const body = await readTextFileRemote(sftp, remoteConfigPath)
      const config =
        body === null ? {} : parseMusecodeSettingsText(body, 'remote MuseCode settings.json')
      if (!config) {
        return {
          agent: 'musecode',
          state: 'error',
          configPath: remoteConfigPath,
          managedHooksPresent: false,
          detail: 'Could not parse remote MuseCode settings.json'
        }
      }
      const command = getMusecodeRemoteManagedCommand(remoteScriptPath)
      // Write the script and managed hooks file first so settings.json never points at missing files.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript())
      await writeTextFileRemoteAtomic(
        sftp,
        remoteManagedHooksPath,
        buildMusecodeManagedHooksFile(command)
      )
      await writeTextFileRemoteAtomic(
        sftp,
        remoteConfigPath,
        serializeMusecodeSettings(body, remoteManagedHooksPath)
      )
      return {
        agent: 'musecode',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'musecode',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getMusecodeConfigPath()
    const managedHooksPath = getMusecodeManagedHooksPath()
    const source = readMusecodeSettingsSource(configPath)
    if (!source) {
      return {
        agent: 'musecode',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read MuseCode settings.json'
      }
    }
    if (source.config.managed_hooks_path === managedHooksPath) {
      const nextText = serializeMusecodeSettings(source.text, undefined)
      if (source.text !== nextText) {
        writeTextFileAtomic(configPath, nextText)
      }
    }
    try {
      if (existsSync(managedHooksPath)) {
        unlinkSync(managedHooksPath)
      }
    } catch {
      // best effort
    }
    return this.getStatus()
  }
}

export const musecodeHookService = new MusecodeHookService()
