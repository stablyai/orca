import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  isPlainObject,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand
} from '../agent-hooks/installer-utils'

const KIRO_SCRIPT_BASE = 'kiro-hook'

/**
 * Lifecycle triggers kiro-cli V3 fires from standalone `.kiro/hooks/*.json` files, captured
 * from a real `kiro-cli chat --tui --v3` session (2.27.0). Kiro uses Claude's names here, not
 * the `PromptSubmit`/`AgentStop` spelling its docs show: 2.27 drops entries with those
 * triggers when it loads the file, so they never fire.
 */
export const KIRO_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd'
] as const

export type KiroHooksFile = {
  version?: unknown
  hooks?: unknown
  [key: string]: unknown
}

export function getKiroHooksFilePath(): string {
  // Why a file of its own: kiro-cli V3 loads every `~/.kiro/hooks/*.json`, so Orca never has
  // to edit an agent config the user (or a dotfiles installer) owns.
  return join(homedir(), '.kiro', 'hooks', 'orca-agent-status.json')
}

export function getKiroRemoteHooksFilePath(remoteHome: string): string {
  return `${remoteHome.replace(/\/$/, '')}/.kiro/hooks/orca-agent-status.json`
}

export function getKiroManagedScriptFileName(): string {
  return process.platform === 'win32' ? `${KIRO_SCRIPT_BASE}.cmd` : `${KIRO_SCRIPT_BASE}.sh`
}

export function getKiroPosixManagedScriptFileName(): string {
  return `${KIRO_SCRIPT_BASE}.sh`
}

export function getKiroManagedScriptPath(): string {
  return getSharedManagedScriptPath(getKiroManagedScriptFileName())
}

export function getKiroManagedCommand(scriptPath: string): string {
  if (process.platform === 'win32') {
    // Why: Kiro runs a `command` action through a shell, so the bare .cmd is enough on a safe
    // path; anything else falls back to the encoded PowerShell launcher.
    return wrapWindowsCmdHookCommand(scriptPath)
  }
  return wrapPosixHookCommand(scriptPath)
}

export function getKiroRemoteManagedCommand(scriptPath: string): string {
  return wrapPosixHookCommand(scriptPath)
}

export function buildKiroHooksFile(command: string): KiroHooksFile {
  return {
    version: 'v1',
    hooks: KIRO_HOOK_EVENTS.map((trigger) => ({
      name: `orca-agent-status-${trigger}`,
      trigger,
      action: { type: 'command', command },
      timeout: MANAGED_HOOK_TIMEOUT_SECONDS
    }))
  }
}

function kiroHookEntries(file: KiroHooksFile): unknown[] {
  return Array.isArray(file.hooks) ? file.hooks : []
}

function runsManagedKiroScript(entry: unknown): boolean {
  const action = isPlainObject(entry) ? entry.action : undefined
  return (
    isPlainObject(action) &&
    typeof action.command === 'string' &&
    createManagedCommandMatcher(getKiroManagedScriptFileName())(action.command)
  )
}

/**
 * Triggers in `file` whose action runs Orca's managed Kiro script. `activeOnly` keeps just the
 * entries Kiro would run: none unless the file is `version: "v1"`, and none marked `enabled: false`.
 */
export function readManagedKiroHookEvents(
  file: KiroHooksFile,
  options: { activeOnly?: boolean } = {}
): Set<string> {
  const present = new Set<string>()
  if (options.activeOnly && file.version !== 'v1') {
    return present
  }
  for (const entry of kiroHookEntries(file)) {
    if (!isPlainObject(entry) || typeof entry.trigger !== 'string') {
      continue
    }
    if (options.activeOnly && entry.enabled === false) {
      continue
    }
    if (runsManagedKiroScript(entry)) {
      present.add(entry.trigger)
    }
  }
  return present
}

/** Whether every hook in `file` runs Orca's script, so the file is Orca's to rewrite or delete. */
export function isOrcaOwnedKiroHooksFile(file: KiroHooksFile): boolean {
  return kiroHookEntries(file).every(runsManagedKiroScript)
}

/** `file` with the hooks that run Orca's script dropped and every other hook kept as is. */
export function removeManagedKiroHooks(file: KiroHooksFile): KiroHooksFile {
  return { ...file, hooks: kiroHookEntries(file).filter((entry) => !runsManagedKiroScript(entry)) }
}
