import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { dirname, join, posix as pathPosix } from 'path'
import { randomUUID } from 'crypto'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import {
  readTextFileRemote,
  writeManagedScriptRemote,
  writeTextFileRemoteAtomic
} from '../agent-hooks/installer-utils-remote'
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

// Always a POSIX `.sh` script: Kimi runs hook commands through its shell, which
// is Git Bash even on Windows (see the CLI README / KIMI_SHELL_PATH), so a
// single curl-based script body works on every platform.
const MANAGED_SCRIPT_FILE_NAME = 'kimi-hook.sh'

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(MANAGED_SCRIPT_FILE_NAME)
}

function getManagedCommand(scriptPath: string): string {
  // Forward slashes so Kimi's Git Bash shell accepts the path on Windows.
  const posixPath = process.platform === 'win32' ? scriptPath.replaceAll('\\', '/') : scriptPath
  return wrapPosixHookCommand(posixPath)
}

function getManagedScript(): string {
  return [
    '#!/bin/sh',
    // Why: refresh PORT/TOKEN/ENV/VERSION from the current Orca install so a PTY
    // that survived an Orca restart still reaches the live listener. See
    // claude/hook-service.ts for the full rationale.
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'payload=$(cat)',
    'if [ -z "$payload" ]; then',
    '  exit 0',
    'fi',
    // Why: worktreeId embeds a filesystem path, so hand-building JSON in POSIX
    // shell is not safe once a path contains quotes or newlines. Post the raw
    // hook payload plus metadata as form fields and let the receiver parse it.
    'curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/kimi" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload=${payload}" >/dev/null 2>&1 || true',
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
  if (existsSync(configPath)) {
    try {
      if (readFileSync(configPath, 'utf-8') === text) {
        return
      }
    } catch {
      // Fall through to the atomic write path.
    }
  }
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, text, 'utf-8')
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
    const isManagedCommand = createManagedCommandMatcher(MANAGED_SCRIPT_FILE_NAME)
    return buildStatus(readManagedKimiHookEvents(text, isManagedCommand), configPath)
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
    writeConfigToml(configPath, applyManagedKimiHooks(text, command))
    return this.getStatus()
  }

  // Why: install Orca's managed Kimi hooks on a remote box over SFTP, mirroring
  // the local install. POSIX-only by design (Kimi's shell is sh/Git Bash); the
  // managed script body is already platform-independent.
  async installRemote(sftp: SFTPWrapper, remoteHome: string): Promise<AgentHookInstallStatus> {
    const remoteConfigPath = pathPosix.join(remoteHome, '.kimi-code', 'config.toml')
    const remoteScriptPath = pathPosix.join(
      remoteHome,
      '.orca',
      'agent-hooks',
      MANAGED_SCRIPT_FILE_NAME
    )
    try {
      // null (file absent) → start from an empty config; Kimi creates it lazily.
      const text = (await readTextFileRemote(sftp, remoteConfigPath)) ?? ''
      const command = wrapPosixHookCommand(remoteScriptPath)
      // Write the script first so config.toml never points at a missing script.
      await writeManagedScriptRemote(sftp, remoteScriptPath, getManagedScript())
      await writeTextFileRemoteAtomic(sftp, remoteConfigPath, applyManagedKimiHooks(text, command))
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
    const { text: nextText, changed } = removeManagedKimiHooks(text)
    if (changed) {
      writeConfigToml(configPath, nextText)
    }
    return this.getStatus()
  }
}

export const kimiHookService = new KimiHookService()
