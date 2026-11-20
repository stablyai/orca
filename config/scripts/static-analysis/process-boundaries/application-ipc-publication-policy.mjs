// Terminal side effects stay native with the PTY delivery path; the transport change owns them.
export const DEFERRED_APPLICATION_PUBLICATIONS = new Map([
  ['src/main/startup/main-process-ready-runtime.ts', ['pty:sideEffect']]
])

export const APPLICATION_PUBLICATION_ROOTS = [
  'src/main/star-nag/service.ts',
  'src/main/rate-limits/service/service-state.ts',
  'src/main/startup/plugin-startup/main-process-plugins.ts',
  'src/main/startup/main-window/main-window-agent-status.ts',
  'src/main/startup/cloud-startup/main-process-relay-status.ts',
  'src/main/startup/wsl-startup/wsl-orcad-account-env-wiring.ts',
  'src/main/startup/runtime-startup/main-process-runtime-launch.ts',
  ...DEFERRED_APPLICATION_PUBLICATIONS.keys()
]
