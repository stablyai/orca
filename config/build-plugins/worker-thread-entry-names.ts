// Electron is unavailable in main-process worker threads too (verified Electron 43); scan their graphs rather than trusting entry comments.
export const WORKER_THREAD_ENTRY_NAMES = [
  'runtime-environment-store-worker-entry',
  'warp-theme-parser-worker',
  'foreign-sqlite-reader-entry',
  'agent-identity-worker-entry',
  'bots-db-worker-entry',
  'pipeline-store-worker-entry',
  'orchestration-reader-entry',
  'session-search-worker-entry',
  'journal-sql-worker-entry',
  'journal-sql-reader-entry',
  'main-thread-hang-watchdog-entry',
  'port-scan-command-worker-entry',
  'command-path-directory-worker-entry',
  'worker-thread-child-process-entry',
  ...(['usage-scan', 'workspace-space-scan'] as const).map((n) => `${n}-worker-entry` as const),
  'codex-history-disk-usage-worker-entry',
  'codex-rollout-history-references-worker-entry',
  'codex-project-trust-worker-entry',
  'claude-profile-setup-worker-entry',
  ...(['backup', 'writer'] as const).map((kind) => `profile-state-${kind}-worker-entry` as const),
  'plugin-source-transpile-worker-entry'
] as const
