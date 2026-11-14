// The CLI loads these paths after electron-vite replaces out/main.
export const CLI_MAIN_ENTRY_NAMES = [
  'worker-threads/worker-thread-entry-path',
  'worker-threads/worker-thread-spawn',
  'agent-hooks/installation/managed-agent-hook-controls',
  'gitlab/projects/project-ref-parser',
  'orca-profiles/profile-index-store',
  'claude-accounts/runtime-auth/keychain',
  // The CLI checks a relocated runtime socket dir before it sends the auth token.
  'daemon/endpoint/publication/daemon-socket-endpoint-path',
  'skills/bundled-skill-install/bundled-skill-local-host',
  'skills/bundled-skill-install/bundled-skill-installation',
  'filesystem/macos-tree-clone',
  'orcad/instance-lock/orcad-stale-lock-reclaim',
  'orcad/profile-state/orcad-host-identity-reset',
  'plugins/plugin-artifact-validation',
  'plugins/plugin-content-hash',
  'plugins/plugin-catalog-release-entry',
  // `orca vm env doctor` runs its checks in the CLI process.
  'environment-doctor/environment-doctor',
  'environment-doctor/environment-doctor-host',
  'persistence/profile-state/access/profile-state-access',
  'persistence/profile-state/offline-access/profile-state-active-location',
  'persistence/profile-state/database/profile-state-storage-classification',
  'persistence/profile-state/offline-access/profile-state-offline-settings',
  'persistence/profile-state/backup/profile-state-backup-path',
  'persistence/profile-state/recovery/profile-state-database-recovery',
  'persistence/profile-state/documents/profile-state-domain-reader',
  'persistence/profile-state/recovery/profile-state-recovery-command',
  'persistence/profile-state/legacy-json/profile-state-export-path',
  'persistence/profile-state/legacy-json/profile-state-recovery',
  'startup/network-compatibility/http1-compatibility-marker'
] as const
