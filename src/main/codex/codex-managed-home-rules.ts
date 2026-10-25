import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { observe } from './codex-path-observation'

const RULES_DIR_NAME = 'rules'
// Sorts before account files (byte order) so last-one-wins rules let account choices override globals.
const GLOBAL_RULE_COPY_PREFIX = '_orca-global-'

/** Codex reads every regular `.rules` file in the dir, sorted; symlinked files are skipped. */
function readRuleFiles(dir: string): Map<string, string> | null {
  const names = observe(() => readdirSync(dir))
  if (names.kind === 'absent') {
    return new Map()
  }
  if (names.kind === 'indeterminate') {
    return null
  }
  const files = new Map<string, string>()
  for (const name of names.value) {
    if (name.endsWith('.rules') && lstatSync(join(dir, name)).isFile()) {
      files.set(name, readFileSync(join(dir, name), 'utf8'))
    }
  }
  return files
}

/**
 * Copies global rules beside the account's own files so Codex still persists
 * approvals to the account's default.rules instead of the user's ~/.codex.
 */
export function syncSystemCodexRulesIntoManagedHome(
  systemHomePath: string,
  managedHomePath: string
): void {
  const sourceDir = join(systemHomePath, RULES_DIR_NAME)
  const targetDir = join(managedHomePath, RULES_DIR_NAME)
  try {
    const target = observe(() => lstatSync(targetDir))
    if (target.kind === 'indeterminate') {
      return
    }
    if (target.kind === 'present') {
      // A linked or shared dir already exposes its own rules; writing would leak copies into it.
      const source = observe(() => realpathSync(sourceDir))
      if (
        !target.value.isDirectory() ||
        (source.kind === 'present' && source.value === realpathSync(targetDir))
      ) {
        return
      }
    }
    const desired = readRuleFiles(sourceDir)
    // Unreadable globals keep the last imported copies so restrictions are not silently dropped.
    if (!desired) {
      return
    }
    const existing = readRuleFiles(targetDir) ?? new Map<string, string>()
    for (const name of existing.keys()) {
      if (
        name.startsWith(GLOBAL_RULE_COPY_PREFIX) &&
        !desired.has(name.slice(GLOBAL_RULE_COPY_PREFIX.length))
      ) {
        rmSync(join(targetDir, name), { force: true })
      }
    }
    for (const [name, contents] of desired) {
      const copyName = `${GLOBAL_RULE_COPY_PREFIX}${name}`
      if (existing.get(copyName) !== contents) {
        mkdirSync(targetDir, { recursive: true })
        writeFileAtomically(join(targetDir, copyName), contents)
      }
    }
  } catch (error) {
    console.warn('[codex-home] Failed to import global Codex rules:', error)
  }
}
