export const WSL_AGENT_HOOK_ENV_KEYS = [
  'ORCA_AGENT_HOOK_PORT',
  'ORCA_AGENT_HOOK_TOKEN',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION',
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN'
] as const

export function addWslEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): void {
  const existing = env.WSLENV ?? process.env.WSLENV ?? ''
  const tokens = existing.split(':').filter(Boolean)
  const tokenNames = new Set(tokens.map((token) => token.split('/')[0]))

  for (const key of keys) {
    if (!tokenNames.has(key)) {
      tokens.push(key)
      tokenNames.add(key)
    }
  }

  env.WSLENV = tokens.join(':')
}

export function removeWslEnvKeys(
  env: Record<string, string | undefined>,
  keys: readonly string[]
): void {
  const existing = env.WSLENV ?? process.env.WSLENV ?? ''
  const keySet = new Set(keys)
  const tokens = existing
    .split(':')
    .filter(Boolean)
    .filter((token) => !keySet.has(token.split('/')[0]))

  env.WSLENV = tokens.join(':')
}
