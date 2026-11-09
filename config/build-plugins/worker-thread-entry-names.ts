// Electron is unavailable in main-process worker threads too (verified Electron 43); scan their graphs rather than trusting entry comments.
export const WORKER_THREAD_ENTRY_NAMES = [
  'warp-theme-parser-worker',
  'foreign-sqlite-reader-entry',
  'session-search-worker-entry',
  'main-thread-hang-watchdog-entry',
  'port-scan-command-worker-entry',
  'command-path-directory-worker-entry',
  'worker-thread-child-process-entry',
  ...(['usage-scan', 'workspace-space-scan'] as const).map((n) => `${n}-worker-entry` as const),
  'claude-profile-setup-worker-entry',
  ...(['backup', 'writer'] as const).map((kind) => `profile-state-${kind}-worker-entry` as const),
  'plugin-source-transpile-worker-entry'
] as const
