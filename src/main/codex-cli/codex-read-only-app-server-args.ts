// The config override replaces legacy values before Codex validates config.toml.
export const CODEX_DISABLE_PLUGINS_ARGS = ['-c', 'features.plugins=false'] as const
const CODEX_READ_ONLY_APP_SERVER_TAIL = ['-s', 'read-only', '-a', 'never', 'app-server'] as const

export const CODEX_READ_ONLY_APP_SERVER_ARGS = [
  '-c',
  'approval_policy=never',
  ...CODEX_READ_ONLY_APP_SERVER_TAIL
] as const

// Rate-limit probes are short-lived; plugin startup can launch marketplace
// clones that outlive the probe teardown. Other read-only app-servers retain
// normal plugin behavior.
export const CODEX_RATE_LIMIT_APP_SERVER_ARGS = [
  '-c',
  'approval_policy=never',
  ...CODEX_DISABLE_PLUGINS_ARGS,
  ...CODEX_READ_ONLY_APP_SERVER_TAIL
] as const
