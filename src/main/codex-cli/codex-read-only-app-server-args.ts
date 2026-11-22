// The config override replaces legacy values before Codex validates config.toml.
export const CODEX_DISABLE_PLUGINS_ARGS = ['-c', 'features.plugins=false'] as const
const CODEX_READ_ONLY_APP_SERVER_TAIL = ['-s', 'read-only', '-a', 'never', 'app-server'] as const

export const CODEX_READ_ONLY_APP_SERVER_ARGS = [
  '-c',
  'approval_policy=never',
  ...CODEX_READ_ONLY_APP_SERVER_TAIL
] as const

// Disable plugins only for short-lived probes; marketplace clones can outlive probe teardown.
export const CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS = [
  '-c',
  'approval_policy=never',
  ...CODEX_DISABLE_PLUGINS_ARGS,
  ...CODEX_READ_ONLY_APP_SERVER_TAIL
] as const
