import { homedir } from 'node:os'
import { join } from 'node:path'
import { isPlainObject, MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'
import { getKiroManagedCommandMatcher } from './hook-settings'

const KIRO_STANDALONE_HOOKS_FILE_NAME = 'orca-agent-status.json'

/**
 * Lifecycle triggers kiro-cli's V3 engine (`--v3`) fires from standalone `~/.kiro/hooks/*.json`
 * files, captured from a real `kiro-cli chat --tui --v3` session (2.27.0). V3 uses Claude's
 * names here, not the `PromptSubmit`/`AgentStop` spelling its docs show: 2.27 drops entries
 * with those triggers when it loads the file, so they never fire.
 */
export const KIRO_STANDALONE_HOOK_TRIGGERS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd'
] as const

// Why the home dir, not resolveKiroHomeDir(): the V3 engine ignores KIRO_HOME (kiro-cli 2.27.1)
// and reads standalone hooks from ~/.kiro/hooks, while V2 agent configs follow KIRO_HOME.
export function getKiroStandaloneHooksFilePath(): string {
  return join(homedir(), '.kiro', 'hooks', KIRO_STANDALONE_HOOKS_FILE_NAME)
}

export function getKiroRemoteStandaloneHooksFilePath(remoteHome: string): string {
  return `${remoteHome.replace(/\/$/, '')}/.kiro/hooks/${KIRO_STANDALONE_HOOKS_FILE_NAME}`
}

export function buildKiroStandaloneHooksFile(command: string): Record<string, unknown> {
  return {
    version: 'v1',
    hooks: KIRO_STANDALONE_HOOK_TRIGGERS.map((trigger) => ({
      name: `orca-agent-status-${trigger}`,
      trigger,
      action: { type: 'command', command },
      timeout: MANAGED_HOOK_TIMEOUT_SECONDS
    }))
  }
}

function hookEntries(file: Record<string, unknown>): unknown[] {
  return Array.isArray(file.hooks) ? file.hooks : []
}

function runsManagedKiroScript(entry: unknown): boolean {
  const action = isPlainObject(entry) ? entry.action : undefined
  return (
    isPlainObject(action) &&
    typeof action.command === 'string' &&
    getKiroManagedCommandMatcher()(action.command)
  )
}

/**
 * Triggers in `file` whose entry runs Orca's script. `activeOnly` drops entries marked
 * `enabled: false`, which Kiro skips.
 */
export function readManagedKiroStandaloneTriggers(
  file: Record<string, unknown>,
  options: { activeOnly?: boolean } = {}
): Set<string> {
  const present = new Set<string>()
  for (const entry of hookEntries(file)) {
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

/**
 * Why `file` is not Orca's to rewrite, or null when it is. Only a `version: "v1"` file with a
 * non-empty `hooks` list that all runs Orca's script, and no other field, counts as Orca's.
 */
export function getKiroStandaloneHooksFileConflict(file: Record<string, unknown>): string | null {
  const otherField = Object.keys(file).find((key) => key !== 'version' && key !== 'hooks')
  if (otherField !== undefined) {
    return `it has a field Orca does not write (${otherField})`
  }
  if (!Array.isArray(file.hooks) || file.hooks.length === 0) {
    return 'it has no hooks list'
  }
  if (!file.hooks.every(runsManagedKiroScript)) {
    return 'it has hooks Orca did not write'
  }
  return file.version === 'v1' ? null : 'it is not a version "v1" hooks file'
}

/** `file` with the hooks that run Orca's script dropped and every other hook kept as is. */
export function removeManagedKiroStandaloneHooks(
  file: Record<string, unknown>
): Record<string, unknown> {
  return { ...file, hooks: hookEntries(file).filter((entry) => !runsManagedKiroScript(entry)) }
}
