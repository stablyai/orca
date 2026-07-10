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

export function isHostCodexHomeForWsl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }
  return /^[A-Za-z]:(?:[\\/]|$)/.test(trimmed) || trimmed.startsWith('\\\\')
}

export function isWslCodexHomeForHost(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }
  return trimmed.startsWith('/')
}
