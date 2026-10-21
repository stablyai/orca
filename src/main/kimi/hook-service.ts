import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix as pathPosix } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  buildWindowsAgentHookCurlPostCommand,
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { wrapWindowsBatchHookCommand } from '../agent-hooks/windows-direct-cmd-hook-command'
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
import {
  applyManagedKimiHooks,
  KIMI_HOOK_EVENTS,
  readManagedKimiHookEvents,
  removeManagedKimiHooks
} from './kimi-hook-config-toml'

// Why: match the CLI's `KIMI_CODE_HOME ?? ~/.kimi-code` resolution (also used by
// kimi-fetcher.ts and the AI Vault session scanner) so hooks land in the same
// home Kimi reads at launch.
function getKimiHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code')
}

function getConfigPath(): string {
  return join(getKimiHome(), 'config.toml')
}

// Kimi runs hooks with asyncio.create_subprocess_shell: cmd.exe on Windows, sh
// elsewhere (it needs Git Bash only for its Shell tool). SSH remotes keep the .sh.
const POSIX_SCRIPT_FILE_NAME = 'kimi-hook.sh'
const WINDOWS_SCRIPT_FILE_NAME = 'kimi-hook.cmd'

// Ownership test for every managed-block path: status, install, remove and the
// bounded orphan recovery all agree on what counts as an Orca-written hook. It
// matches every extension of the stem, so a pre-fix Windows `.sh` entry is replaced.
const isManagedKimiCommand = createManagedCommandMatcher(POSIX_SCRIPT_FILE_NAME)

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(
    process.platform === 'win32' ? WINDOWS_SCRIPT_FILE_NAME : POSIX_SCRIPT_FILE_NAME
  )
}

export function getManagedCommand(scriptPath: string): string {
  // Why the direct form's forward slashes are load-bearing: ownership matches the still-escaped
  // TOML literal, where a backslash path reads as `agent-hooks\\kimi-hook.cmd` and never matches.
  return process.platform === 'win32'
    ? wrapWindowsBatchHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: the endpoint file holds this install's live port/token; sourcing it lets a surviving PTY reach the current server (see claude/hook-service.ts).
      'if defined ORCA_AGENT_HOOK_ENDPOINT if exist "%ORCA_AGENT_HOOK_ENDPOINT%" call "%ORCA_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      buildWindowsAgentHookCurlPostCommand('kimi'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixHookSpoolLines('kimi'),
    // Why: refresh PORT/TOKEN/ENV/VERSION from the current Orca install so a PTY
    // that survived an Orca restart still reaches the live listener. See
    // claude/hook-service.ts for the full rationale.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Why: worktreeId embeds a filesystem path, so hand-building JSON in POSIX
    // shell is not safe once a path contains quotes or newlines. Post the raw
    // hook payload plus metadata as form fields and let the receiver parse it.
    // Why: pipe payload to curl's stdin (`payload@-`) instead of an inline
    // `payload=$VALUE` arg, so tens-of-KB tool output stays off the curl
    // command line (EDR command-line false positives). Wire body is identical.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/kimi" \\',
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

// Returns the file text, '' when the config does not exist yet (Kimi creates it
// lazily), or null on an unreadable file so callers can report a structured error.
function readConfigToml(configPath: string): string | null {
  if (!existsSync(configPath)) {
    return ''
  }
  try {
    return readFileSync(configPath, 'utf-8')
  } catch {
    return null
  }
}

// Why: temp+rename keeps a hand-editable config.toml intact if a write is
// interrupted, and a single rolling .bak makes a bad write recoverable.
function writeConfigToml(configPath: string, text: string): void {
  const dir = dirname(configPath)
  mkdirSync(dir, { recursive: true })
  // Why: renameSync replaces the inode, so the temp mode becomes the config mode.
  let mode = 0o600
  if (existsSync(configPath)) {
    try {
      if (readFileSync(configPath, 'utf-8') === text) {
        return
      }
    } catch {
      // Fall through to the atomic write path.
    }
    try {
      mode = statSync(configPath).mode & 0o777
    } catch (error) {
      // Why: file was deleted between the existsSync check and here — nothing to preserve.
      if (!isDefinitiveAbsence(error)) {
        throw error
      }
    }
  }
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, text, { encoding: 'utf-8', mode: 0o600 })
    chmodSync(tmpPath, mode)
    if (existsSync(configPath)) {
      copyFileSync(configPath, `${configPath}.bak`)
    }
    renameSync(tmpPath, configPath)
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort
      }
    }
  }
}

function buildStatus(present: Set<string>, configPath: string): AgentHookInstallStatus {
  const missing = KIMI_HOOK_EVENTS.filter((event) => !present.has(event))
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
  return { agent: 'kimi', state, configPath, managedHooksPresent: present.size > 0, detail }
}

export class KimiHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const text = readConfigToml(configPath)
    if (text === null) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kimi config.toml'
      }
    }
    return buildStatus(readManagedKimiHookEvents(text, isManagedKimiCommand), configPath)
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const text = readConfigToml(configPath)
    if (text === null) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kimi config.toml'
      }
    }
    const scriptPath = getManagedScriptPath()
    const command = getManagedCommand(scriptPath)
    // Write the script first so config.toml never points at a missing script.
    writeManagedScript(scriptPath, getManagedScript())
    writeConfigToml(configPath, applyManagedKimiHooks(text, command, isManagedKimiCommand))
    return this.getStatus()
  }

  // Why: install Orca's managed Kimi hooks on a remote box over SFTP, mirroring
  // the local install. POSIX-only by design: remote hosts run hooks through sh.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = pathPosix.join(remoteHome, '.kimi-code', 'config.toml')
    const remoteScriptPath = pathPosix.join(
      remoteHome,
      '.orca',
      'agent-hooks',
      POSIX_SCRIPT_FILE_NAME
    )
    try {
      // null (file absent) → start from an empty config; Kimi creates it lazily.
      const text = (await readTextFileRemote(sftp, remoteConfigPath)) ?? ''
      const command = wrapPosixHookCommand(remoteScriptPath)
      // Write the script first so config.toml never points at a missing script.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript('posix'))
      await writeTextFileRemoteAtomic(
        sftp,
        remoteConfigPath,
        applyManagedKimiHooks(text, command, isManagedKimiCommand)
      )
      return {
        agent: 'kimi',
        state: 'installed',
        configPath: remoteConfigPath,
        managedHooksPresent: true,
        detail: null
      }
    } catch (err) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath: remoteConfigPath,
        managedHooksPresent: false,
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const text = readConfigToml(configPath)
    if (text === null) {
      return {
        agent: 'kimi',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kimi config.toml'
      }
    }
    const { text: nextText, changed } = removeManagedKimiHooks(text, isManagedKimiCommand)
    if (changed) {
      writeConfigToml(configPath, nextText)
    }
    return this.getStatus()
  }
}

export const kimiHookService = new KimiHookService()
