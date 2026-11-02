// The CLI loads these paths after electron-vite replaces out/main.
export const CLI_MAIN_ENTRY_NAMES = [
  'agent-hooks/managed-agent-hook-controls',
  'agent-hooks/wsl-hook-command-session',
  'agent-hooks/wsl-hook-fs-adapter',
  'agent-hooks/managed-hook-detection-commands',
  'claude/hook-service',
  'gitlab/project-ref-parser',
  'orca-profiles/profile-index-store',
  'claude-accounts/keychain',
  'skills/bundled-skill-install/cli-entry',
  'macos-tree-clone',
  'orcad/orcad-stale-lock-reclaim',
  'plugins/plugin-authoring-checks',
  ...[
    'access',
    'active-location',
    'storage-classification',
    'offline-settings',
    'backup-path',
    'database-recovery',
    'domain-reader',
    'recovery-command'
  ].map((module) => `persistence/profile-state/profile-state-${module}`),
  'persistence/profile-state/legacy-json/profile-state-export-path',
  'persistence/profile-state/legacy-json/profile-state-recovery',
  'startup/http1-compatibility-marker'
] as const
