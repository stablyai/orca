import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { HooksConfig } from '../agent-hooks/installer-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
import { isPlainObject, readHooksJsonWithRaw } from '../agent-hooks/hooks-json-read'
import { getSystemCodexHomePath } from './codex-home-paths'
import {
  getCodexExplicitHomeHookSourcePath,
  normalizeCodexHookSourcePath
} from './config-toml-trust'

/** The user's real `~/.codex` hook files, plus the guard and pristine backup
 *  the real-home lane needs before it is allowed to mutate them. */
export function getRealHomeHooksJsonPath(): string {
  return join(getSystemCodexHomePath(), 'hooks.json')
}

/**
 * Every key Codex may give an entry in ~/.codex/hooks.json: as spelled when it
 * runs on its default home, resolved when a pane's CODEX_HOME names it. They
 * differ when ~/.codex or HOME is a symlink, and Orca approves under both.
 */
export function getRealHomeHookKeySourcePaths(): [string, ...string[]] {
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const spelled = normalizeCodexHookSourcePath(hooksJsonPath)
  const resolved = getCodexExplicitHomeHookSourcePath(hooksJsonPath)
  return resolved === spelled ? [spelled] : [spelled, resolved]
}

/** Orca-side home of the pristine copy; the rolling hooks.json.bak beside the file is writeHooksJson's. */
function getRealHomeHookStateDir(userDataPath: string): string {
  return join(userDataPath, 'codex-real-home-hooks')
}

/** Another process saved hooks.json between Orca's read and its write. */
export class HooksJsonChangedError extends Error {
  constructor() {
    super('Codex hooks.json changed since Orca read it')
    this.name = 'HooksJsonChangedError'
  }
}

/** Why ~/.codex/hooks.json cannot take Orca's entry, read from the file now; null when it can. */
export function readRealHomeHooksFileProblem(): string | null {
  const hooksJsonPath = getRealHomeHooksJsonPath()
  const { raw, config } = readHooksJsonWithRaw(hooksJsonPath)
  if (raw === null) {
    return null
  }
  return isAddableHooksFile(config)
    ? null
    : `Orca cannot add its hook to ${hooksJsonPath}, so Orca shows no status for ~/.codex`
}

// Why: an unparseable user file is never clobbered, and Codex skips a file with other root keys
// or an event that is not a list, whose value Orca would otherwise replace.
export function isAddableHooksFile(config: HooksConfig | null): config is HooksConfig {
  return (
    config !== null &&
    Object.keys(config).every((key) => key === 'hooks' || key === 'description') &&
    (config.hooks === undefined ||
      (isPlainObject(config.hooks) && Object.values(config.hooks).every(Array.isArray)))
  )
}

export function assertHooksJsonGeneration(
  hooksJsonPath: string,
  hooksWritePath: string,
  expectedRaw: string | null
): void {
  const currentRaw = existsSync(hooksJsonPath) ? readFileSync(hooksJsonPath, 'utf-8') : null
  if (currentRaw !== expectedRaw || resolveHooksJsonWritePath(hooksJsonPath) !== hooksWritePath) {
    // Why: another process may have saved since the read. Abort rather than
    // atomically replacing a newer file with the stale parsed snapshot.
    throw new HooksJsonChangedError()
  }
}

/** One-time pristine copy of the user's file, kept under Orca's userData. */
export function backupRealHomeHooksJsonOnce(
  userDataPath: string,
  previousRaw: string | null
): void {
  if (previousRaw === null) {
    return
  }
  const backupDir = getRealHomeHookStateDir(userDataPath)
  const backupPath = join(backupDir, 'hooks.json.pre-orca')
  if (existsSync(backupPath)) {
    return
  }
  // Why: this lane mutates the user's real Codex home. If the required
  // pristine recovery copy cannot be created, keep the managed lane intact.
  mkdirSync(backupDir, { recursive: true })
  writeFileAtomically(backupPath, previousRaw, { mode: 0o600 })
}
