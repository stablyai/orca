import { homedir } from 'node:os'
import { join } from 'node:path'
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
  return expandHostHomePrefix(normalizeSourceHome(settings.codexSessionSourceHome?.host))
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
  if (!value?.startsWith('~/') && !value?.startsWith('~\\')) {
    return value
  }
  return join(homedir(), value.slice(2))
}
