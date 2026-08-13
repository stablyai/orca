import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePathEnvKey } from './windows-environment-path'

const LEGACY_SHIM_ROOT_DIR = 'orca-terminal-attribution'
const LEGACY_SHIM_ENV_KEYS = [
  'ORCA_ENABLE_GIT_ATTRIBUTION',
  'ORCA_GIT_COMMIT_TRAILER',
  'ORCA_GH_PR_FOOTER',
  'ORCA_GH_ISSUE_FOOTER',
  'ORCA_ATTRIBUTION_SHIM_DIR',
  'ORCA_REAL_GIT',
  'ORCA_REAL_GH'
] as const

let removed = false

/** Why: a daemon that outlives an upgrade keeps seeding these from its own process.env
 *  (pty-subprocess reads process.env as the authoritative base), and the wrappers they
 *  point at are gated only on inherited env. Deleting the scripts makes both inert. */
export function removeLegacyTerminalShimDir(userDataPath: string): void {
  if (removed) {
    return
  }
  removed = true
  try {
    rmSync(join(userDataPath, LEGACY_SHIM_ROOT_DIR), { recursive: true, force: true })
  } catch {
    // Best-effort: a locked file must not block startup.
  }
}

export function stripLegacyTerminalShimEnv(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): void {
  for (const key of LEGACY_SHIM_ENV_KEYS) {
    delete env[key]
  }
  const pathKey = resolvePathEnvKey(env, platform)
  const current = env[pathKey]
  if (!current) {
    return
  }
  const delimiter = platform === 'win32' ? ';' : ':'
  const cleaned = current
    .split(delimiter)
    .filter((entry) => entry && !entry.replaceAll('\\', '/').includes(`/${LEGACY_SHIM_ROOT_DIR}/`))
    .join(delimiter)
  if (cleaned) {
    env[pathKey] = cleaned
  } else {
    delete env[pathKey]
  }
}

export const LEGACY_TERMINAL_SHIM_ENV_KEYS = LEGACY_SHIM_ENV_KEYS

/** Test-only: the module-level once-guard would otherwise leak across cases. */
export function __resetLegacyTerminalShimRemovalForTests(): void {
  removed = false
}
