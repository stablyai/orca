import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { resolveHooksJsonWritePath } from '../agent-hooks/hook-config-write-path'
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

export function getRealHomeConfigTomlPath(): string {
  return join(getSystemCodexHomePath(), 'config.toml')
}

/** Orca-side state dir; nothing extra is ever written into the user's ~/.codex. */
function getRealHomeHookStateDir(userDataPath: string): string {
  return join(userDataPath, 'codex-real-home-hooks')
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
    throw new Error('Codex hooks.json changed since Orca read it')
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
