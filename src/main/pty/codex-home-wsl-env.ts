/** Guest-relative layout of Orca's managed WSL CODEX_HOME. Must stay in sync
 *  with getWslRuntimeHomePath (codex-accounts/runtime-home-service.ts), which
 *  builds the UNC twin of this path. */
export const WSL_CODEX_RUNTIME_HOME_SEGMENTS = [
  '.local',
  'share',
  'orca',
  'codex-runtime-home',
  'home'
] as const

export function wslCodexRuntimeHomeForGuestHome(guestHome: string): string {
  const home = guestHome.endsWith('/') ? guestHome.slice(0, -1) : guestHome
  return `${home}/${WSL_CODEX_RUNTIME_HOME_SEGMENTS.join('/')}`
}

/**
 * Host Windows CODEX_HOME paths cannot be consumed by Codex inside WSL.
 *
 * When a WSL shell inherits a host-managed CODEX_HOME (drive letter or UNC
 * that is not a same-distro WSL path), callers must strip CODEX_HOME and
 * ORCA_CODEX_HOME so the distro falls back to Linux ~/.codex or a
 * WSL-managed account home — not the host account selection.
 */
export function isHostCodexHomeForWsl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }
  return /^[A-Za-z]:(?:[\\/]|$)/.test(trimmed) || trimmed.startsWith('\\\\')
}

/**
 * Linux CODEX_HOME paths cannot be consumed by host Windows Codex.
 * Callers launching a non-WSL shell should strip these so Windows Codex does
 * not inherit a path it cannot open.
 */
export function isWslCodexHomeForHost(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }
  return trimmed.startsWith('/')
}

/** True when a WSL shell must drop the current CODEX_HOME host path. */
export function shouldStripHostCodexHomeForWslShell(
  codexHome: string | undefined
): boolean {
  return isHostCodexHomeForWsl(codexHome)
}

/**
 * User-facing explanation for host vs WSL Codex home separation.
 * Prefer surfacing this near account/runtime pickers when host CODEX_HOME is
 * not injected into WSL terminals.
 */
export function getHostCodexHomeStrippedForWslMessage(): string {
  return (
    'WSL terminals use the distro Codex home (~/.codex or a WSL-managed account), ' +
    'not the host Windows CODEX_HOME.'
  )
}
