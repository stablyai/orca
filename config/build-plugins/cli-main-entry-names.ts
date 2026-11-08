// The CLI loads these paths after electron-vite replaces out/main.
export const CLI_MAIN_ENTRY_NAMES = [
  'agent-hooks/managed-agent-hook-controls',
  'gitlab/project-ref-parser',
  'orca-profiles/profile-index-store',
  'claude-accounts/keychain',
  'skills/bundled-skill-install/bundled-skill-local-host',
  'skills/bundled-skill-install/bundled-skill-installation',
  'filesystem/macos-tree-clone',
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
