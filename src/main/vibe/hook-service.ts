import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  wrapPosixHookCommand,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import {
  applyManagedVibeHooks,
  readManagedVibeHookTypes,
  removeManagedVibeHooks,
  VIBE_HOOK_TYPES
} from './hook-config-toml'
import { getVibeManagedScript } from './hook-script-source'

// Why: match Vibe's `VIBE_HOME ?? ~/.vibe` resolution so hooks land where Vibe
// reads them at launch.
function getVibeHome(): string {
  return process.env.VIBE_HOME?.trim() || join(homedir(), '.vibe')
}

function getConfigPath(): string {
  return join(getVibeHome(), 'hooks.toml')
}

// Always a POSIX `.sh` script: Vibe runs hook commands through a shell. Windows
// is not yet supported (see VIBE_INTEGRATION.md).
const MANAGED_SCRIPT_FILE_NAME = 'mistral-vibe-hook.sh'

// Why: Vibe spawns hook commands via asyncio.create_subprocess_shell (cmd.exe on
// Windows), so a /bin/sh script is not directly executable there. Unlike Kimi
// (Git Bash on Windows), Vibe has no working shell for `.sh` on win32 — installing
// would write a hook Vibe cannot run, and a failed pre_tool could gate tools.
// Skip the whole service on Windows until a .cmd launcher exists.
function isUnsupportedPlatform(): boolean {
  return process.platform === 'win32'
}

function unsupportedStatus(configPath: string): AgentHookInstallStatus {
  return {
    agent: 'mistral-vibe',
    state: 'skipped',
    configPath,
    managedHooksPresent: false,
    detail: 'Vibe hooks are POSIX-only; Windows is not yet supported.',
    skipReason: 'platform_unsupported'
  }
}

// Why: a home dir reused after a macOS/Linux install can still hold the managed
// POSIX pre_tool command, which Vibe runs via cmd.exe on Windows and fails
// before tool calls. Strip any stale managed block so win32 never inherits a
// broken hook; no-op (no write) when the block is already absent.
function stripStaleManagedBlock(): void {
  const configPath = getConfigPath()
  const text = readConfigToml(configPath)
  if (text === null || text.length === 0) {
    return
  }
  const { text: nextText, changed } = removeManagedVibeHooks(text)
  if (changed) {
    writeConfigToml(configPath, nextText)
  }
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(MANAGED_SCRIPT_FILE_NAME)
}

function getManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

// Returns the file text, '' when the config does not exist yet (Vibe creates it
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

// Why: temp+rename keeps a hand-editable hooks.toml intact if a write is
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
  const missing = VIBE_HOOK_TYPES.filter((type) => !present.has(type))
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
    detail = `Managed hook missing for types: ${missing.join(', ')}`
  }
  return { agent: 'mistral-vibe', state, configPath, managedHooksPresent: present.size > 0, detail }
}

export class VibeHookService {
  async refreshManagedScripts(): Promise<void> {
    if (isUnsupportedPlatform()) {
      return
    }
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getVibeManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    if (isUnsupportedPlatform()) {
      return unsupportedStatus(configPath)
    }
    const text = readConfigToml(configPath)
    if (text === null) {
      return {
        agent: 'mistral-vibe',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Vibe hooks.toml'
      }
    }
    const isManagedCommand = createManagedCommandMatcher(MANAGED_SCRIPT_FILE_NAME)
    return buildStatus(readManagedVibeHookTypes(text, isManagedCommand), configPath)
  }

  install(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    if (isUnsupportedPlatform()) {
      // Why: cannot install on win32, but do not leave a stale POSIX hook from
      // a prior macOS/Linux install that Vibe would fail to execute.
      stripStaleManagedBlock()
      return unsupportedStatus(configPath)
    }
    const text = readConfigToml(configPath)
    if (text === null) {
      return {
        agent: 'mistral-vibe',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Vibe hooks.toml'
      }
    }
    const scriptPath = getManagedScriptPath()
    const command = getManagedCommand(scriptPath)
    // Write the script first so hooks.toml never points at a missing script.
    writeManagedScript(scriptPath, getVibeManagedScript())
    writeConfigToml(configPath, applyManagedVibeHooks(text, command))
    return this.getStatus()
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    if (isUnsupportedPlatform()) {
      // Why: on win32 the install path is skipped, but a stale block from a
      // prior macOS/Linux install should still be cleaned up on explicit remove.
      stripStaleManagedBlock()
      return unsupportedStatus(configPath)
    }
    const text = readConfigToml(configPath)
    if (text === null) {
      return {
        agent: 'mistral-vibe',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Vibe hooks.toml'
      }
    }
    const { text: nextText, changed } = removeManagedVibeHooks(text)
    if (changed) {
      writeConfigToml(configPath, nextText)
    }
    return this.getStatus()
  }
}

export const vibeHookService = new VibeHookService()
