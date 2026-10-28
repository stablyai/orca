import { join, posix as pathPosix } from 'node:path'
import { resolveKiroHomeDir } from '../../shared/kiro-home'
import { isPlainObject } from '../agent-hooks/installer-utils'
import {
  buildKiroListHook,
  getKiroManagedCommandMatcher,
  kiroListHookRunsManagedCommand
} from './hook-settings'

const KIRO_STANDALONE_HOOKS_FILE_NAME = 'orca-agent-status.json'

/** V3 triggers (kiro-cli 2.27+); the docs' `PromptSubmit`/`AgentStop` spellings are dropped on load. */
export const KIRO_STANDALONE_HOOK_TRIGGERS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd'
] as const

// V3 reads global hooks from $KIRO_HOME/hooks since kiro-cli 2.31 (2.29 used ~/.kiro/hooks).
export function getKiroStandaloneHooksFilePath(): string {
  return join(resolveKiroHomeDir(), 'hooks', KIRO_STANDALONE_HOOKS_FILE_NAME)
}

export function getKiroRemoteStandaloneHooksFilePath(
  remoteHome: string,
  kiroHomeDir?: string
): string {
  const root = kiroHomeDir ?? pathPosix.join(remoteHome.replace(/\/$/, ''), '.kiro')
  return pathPosix.join(root, 'hooks', KIRO_STANDALONE_HOOKS_FILE_NAME)
}

export function buildKiroStandaloneHooksFile(command: string): Record<string, unknown> {
  return {
    version: 'v1',
    hooks: KIRO_STANDALONE_HOOK_TRIGGERS.map((trigger) => buildKiroListHook(trigger, command))
  }
}

function hookEntries(file: Record<string, unknown>): unknown[] {
  return Array.isArray(file.hooks) ? file.hooks : []
}

function runsManagedKiroScript(entry: unknown): boolean {
  return kiroListHookRunsManagedCommand(entry, getKiroManagedCommandMatcher())
}

/** `activeOnly` drops `enabled: false` entries, which Kiro skips. */
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

/** Why `file` is not Orca's to rewrite, or null when every field and hook is Orca's. */
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

export function removeManagedKiroStandaloneHooks(
  file: Record<string, unknown>
): Record<string, unknown> {
  return { ...file, hooks: hookEntries(file).filter((entry) => !runsManagedKiroScript(entry)) }
}
