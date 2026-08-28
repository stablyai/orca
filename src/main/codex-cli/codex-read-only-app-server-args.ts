// The config override replaces legacy values before Codex validates config.toml.
export const CODEX_READ_ONLY_APP_SERVER_ARGS = [
  '-c',
  'approval_policy=never',
  '-s',
  'read-only',
  '-a',
  'never',
  'app-server'
] as const
