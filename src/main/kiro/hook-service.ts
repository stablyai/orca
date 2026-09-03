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

// Why: Kiro CLI (kiro-cli) only supports lifecycle hooks inside per-agent
// config files (`~/.kiro/agents/*.json`), and its built-in default agent  -
// what `kiro-cli chat` launches - cannot be extended or overridden with hooks
// (verified against kiro-cli 2.15.x: neither a local nor a global agent named
// `kiro_default` is honored, and v3 standalone `.kiro/hooks/*.json` files are
// not read by the v2 engine). So a managed hook script would never fire for
// the default launch path.
//
// Instead, Orca manages Kiro's NATIVE completion notifications: kiro-cli emits
// a terminal BEL at end of turn whenever the hosting terminal has reported
// focus-out (mode 1004, which xterm.js supports) and these settings are on:
//   chat.enableNotifications = true
//   chat.notificationMethod  = "bell"
// Orca's existing terminal-bell notification path then delivers the OS
// notification. `chat.terminalTitle` is also enabled so Kiro's "kiro: <title>"
// OSC titles let Orca attribute the pane (and the notification) to Kiro - see
// AGENT_NAMES in src/shared/agent-name-token-match.ts.
const MANAGED_SETTINGS: Record<string, boolean | string> = {
  'chat.enableNotifications': true,
  'chat.notificationMethod': 'bell',
  'chat.terminalTitle': true
}

const MANAGED_KEYS = Object.keys(MANAGED_SETTINGS)

// Why: install status is judged on the notification pair only. A user can
// legitimately have `chat.terminalTitle` on for their own reasons - that must
// not make Orca report Kiro notifications as partially installed.
const STATUS_KEYS = ['chat.enableNotifications', 'chat.notificationMethod'] as const

type KiroCliSettings = Record<string, unknown>

function getSettingsPath(): string {
  return join(homedir(), '.kiro', 'settings', 'cli.json')
}

// Why: remove() must restore whatever the user had before install(), not blind
// -delete keys - deleting `chat.terminalTitle` a user had enabled themselves
// would silently change their setup. The backup is written once, on the first
// install that actually changes something, and consumed by remove().
function getBackupPath(): string {
  return join(homedir(), '.orca', 'agent-hooks', 'kiro-settings-backup.json')
}

// Returns the parsed settings object, {} when the file does not exist yet
// (kiro-cli creates it lazily), or null on an unreadable/invalid file so
// callers can report a structured error instead of clobbering user settings.
function readSettings(settingsPath: string): KiroCliSettings | null {
  if (!existsSync(settingsPath)) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as KiroCliSettings
    }
    return null
  } catch {
    return null
  }
}

// Why: temp+rename keeps a hand-editable cli.json intact if a write is
// interrupted, and a single rolling .bak makes a bad write recoverable.
// Mirrors the Kimi service's config.toml write path.
function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const text = JSON.stringify(value, null, 2)
  if (existsSync(filePath)) {
    try {
      if (readFileSync(filePath, 'utf-8') === text) {
        return
      }
    } catch {
      // Fall through to the atomic write path.
    }
  }
  const tmpPath = join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    writeFileSync(tmpPath, text, 'utf-8')
    if (existsSync(filePath)) {
      copyFileSync(filePath, `${filePath}.bak`)
    }
    renameSync(tmpPath, filePath)
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

type SettingsBackup = {
  // Value of each managed key before install; a key absent from this record
  // means it did not exist and should be deleted on restore.
  previous: Record<string, unknown>
}

function readBackup(): SettingsBackup | null {
  const backupPath = getBackupPath()
  if (!existsSync(backupPath)) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(backupPath, 'utf-8'))
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as SettingsBackup).previous === 'object' &&
      (parsed as SettingsBackup).previous !== null &&
      !Array.isArray((parsed as SettingsBackup).previous)
    ) {
      return parsed as SettingsBackup
    }
    return null
  } catch {
    return null
  }
}

function buildStatus(settings: KiroCliSettings, configPath: string): AgentHookInstallStatus {
  const missing = STATUS_KEYS.filter((key) => settings[key] !== MANAGED_SETTINGS[key])
  let state: AgentHookInstallState
  let detail: string | null
  if (missing.length === 0) {
    state = 'installed'
    // Why: unlike hook-based agents, Kiro reports status through its native
    // bell - make the mechanism discoverable from the settings UI.
    detail = 'Uses Kiro CLI native notifications (terminal bell on turn completion).'
  } else if (missing.length === STATUS_KEYS.length) {
    state = 'not_installed'
    detail = null
  } else {
    state = 'partial'
    detail = `Managed Kiro CLI settings missing: ${missing.join(', ')}`
  }
  return {
    agent: 'kiro',
    state,
    configPath,
    managedHooksPresent: missing.length < STATUS_KEYS.length,
    detail
  }
}

export class KiroHookService {
  getStatus(): AgentHookInstallStatus {
    const configPath = getSettingsPath()
    const settings = readSettings(configPath)
    if (settings === null) {
      return {
        agent: 'kiro',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kiro CLI settings (cli.json)'
      }
    }
    return buildStatus(settings, configPath)
  }

  install(): AgentHookInstallStatus {
    const configPath = getSettingsPath()
    const settings = readSettings(configPath)
    if (settings === null) {
      return {
        agent: 'kiro',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kiro CLI settings (cli.json)'
      }
    }
    // Snapshot the user's pre-Orca values once, BEFORE any early return, so
    // remove() can always restore them instead of blind-deleting keys. A
    // re-install never overwrites an existing backup.
    if (!readBackup()) {
      const previous: Record<string, unknown> = {}
      for (const key of MANAGED_KEYS) {
        if (key in settings) {
          previous[key] = settings[key]
        }
      }
      writeJsonAtomic(getBackupPath(), { previous } satisfies SettingsBackup)
    }
    const changedKeys = MANAGED_KEYS.filter((key) => settings[key] !== MANAGED_SETTINGS[key])
    if (changedKeys.length === 0) {
      return buildStatus(settings, configPath)
    }
    const next = { ...settings, ...MANAGED_SETTINGS }
    writeJsonAtomic(configPath, next)
    return this.getStatus()
  }

  remove(): AgentHookInstallStatus {
    const configPath = getSettingsPath()
    const settings = readSettings(configPath)
    if (settings === null) {
      return {
        agent: 'kiro',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not read Kiro CLI settings (cli.json)'
      }
    }
    const backup = readBackup()
    // Why: no backup means Orca never recorded a pre-install state (never
    // installed, or a prior remove() already consumed it). Do NOT touch
    // settings that merely happen to equal our managed values - they are the
    // user's, not ours.
    if (!backup) {
      return this.getStatus()
    }
    const next: KiroCliSettings = { ...settings }
    let changed = false
    for (const key of MANAGED_KEYS) {
      // Why: leave keys alone when the user has since changed them away from
      // Orca's managed values - those are their settings now, not ours.
      if (next[key] !== MANAGED_SETTINGS[key]) {
        continue
      }
      if (key in backup.previous) {
        next[key] = backup.previous[key]
      } else {
        delete next[key]
      }
      changed = true
    }
    if (changed) {
      writeJsonAtomic(configPath, next)
    }
    const backupPath = getBackupPath()
    if (existsSync(backupPath)) {
      try {
        unlinkSync(backupPath)
      } catch {
        // best effort
      }
    }
    return this.getStatus()
  }
}

export const kiroHookService = new KiroHookService()
