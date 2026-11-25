// The config override replaces legacy values before Codex validates config.toml.
export const CODEX_DISABLE_PLUGINS_ARGS = ['-c', 'features.plugins=false'] as const

// No root -s/-a: app-server ignores them, and Codex rejects them beside the Command's own --yolo, -a or -s.
export const CODEX_READ_ONLY_APP_SERVER_ARGS = [
  '-c',
  'approval_policy=never',
  'app-server'
] as const

// Disable plugins only for short-lived probes; marketplace clones can outlive probe teardown.
export const CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS = [
  '-c',
  'approval_policy=never',
  ...CODEX_DISABLE_PLUGINS_ARGS,
  'app-server'
] as const
