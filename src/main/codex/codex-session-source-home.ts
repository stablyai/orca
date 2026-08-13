import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { GlobalSettings } from '../../shared/types'

/**
 * Resolves the user-configured Codex *session history* source home, if any.
 *
 * Why: Orca relocates CODEX_HOME to a managed home, then bridges history from
 * the user's real Codex home so /resume finds it. That source defaults to
 * ~/.codex, but users who run Codex with a custom CODEX_HOME need to point
 * history discovery at that folder. This override affects history only; auth,
 * config, and hooks continue to read from ~/.codex.
 */

/** Host override; returns undefined to keep the default ~/.codex source. */
export function resolveHostCodexSessionSourceHome(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>
): string | undefined {
  const expanded = expandHostHomePrefix(normalizeSourceHome(settings.codexSessionSourceHome?.host))
  // Why: consumers both scan and WRITE through this value (the session backfill
  // resolves <home>/sessions as its target). An unanchored value would mkdir
  // under whatever cwd the app happens to have, and the home directory itself is
  // never a Codex home — accepting `~` or `/` would create a `sessions` tree at
  // a broad filesystem boundary. Reject both; callers fall back to the system home.
  return expanded && isAnchoredAbsolute(expanded) && !isUnsafeHostHomePath(expanded)
    ? expanded
    : undefined
}

// Why not plain isAbsolute: on win32 a rooted-but-driveless `\codex` passes it
// yet still resolves against the CURRENT DRIVE, so it is no better anchored than
// `codex` — and resolving it reads the cwd, which throws if that directory is
// gone. Require a drive or a UNC root there; POSIX is unchanged.
function isAnchoredAbsolute(value: string): boolean {
  if (!isAbsolute(value)) {
    return false
  }
  return (
    sep !== '\\' ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/.test(value)
  )
}

// Callers prove the value is drive/UNC-anchored first, so resolve() only folds
// `.`/`..` here and never reads the cwd. It is load-bearing for a RAW absolute
// value carrying dot segments; `~/..` spellings were already folded by join().
function isUnsafeHostHomePath(value: string): boolean {
  const resolved = resolve(value)
  const normalized = normalizeRuntimePathForComparison(resolved)
  return (
    normalized === normalizeRuntimePathForComparison(resolve(homedir())) ||
    normalized === normalizeRuntimePathForComparison(parse(resolved).root)
  )
}

/** Per-distro WSL override; returns undefined to keep the default <wslHome>/.codex source. */
export function resolveWslCodexSessionSourceHome(
  settings: Pick<GlobalSettings, 'codexSessionSourceHome'>,
  distro: string
): string | undefined {
  const perDistro = settings.codexSessionSourceHome?.wsl
  if (!perDistro) {
    return undefined
  }
  // Why: distro keys are matched case-insensitively so "Ubuntu" and "ubuntu"
  // resolve the same override, mirroring how WSL treats distro names.
  const normalizedDistro = distro.trim().toLowerCase()
  for (const [key, value] of Object.entries(perDistro)) {
    if (key.trim().toLowerCase() === normalizedDistro) {
      return normalizeSourceHome(value)
    }
  }
  return undefined
}

function normalizeSourceHome(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Why: the settings field's placeholder is literally `~/.codex`, so a leading
 * `~` is the natural thing to type. Nothing else expands it, so an unexpanded
 * one silently resolves to no sessions at all — the very symptom the override
 * exists to fix. Host-only: a WSL override names a path inside the distro.
 */
function expandHostHomePrefix(value: string | undefined): string | undefined {
  if (value === '~') {
    return homedir()
  }
  // `~\` is a home prefix only where `\` separates paths; on POSIX it is a
  // legal filename character, so rewriting it would retarget a path the user
  // really typed.
  if (!value?.startsWith('~/') && !(sep === '\\' && value?.startsWith('~\\'))) {
    return value
  }
  return join(homedir(), value.slice(2))
}
