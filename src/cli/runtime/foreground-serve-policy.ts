// Why: must stay equal to SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE in
// src/main/startup/single-instance-lock.ts (systemd RestartPreventExitStatus=3).
export const SERVE_ALREADY_RUNNING_EXIT_CODE = 3

export const SERVE_ALREADY_RUNNING_MESSAGE =
  '[serve] Orca is already running for this userData profile; not starting a second process.'

export function shouldSpawnForegroundServe(status: {
  app: { running: boolean }
  runtime: { reachable: boolean }
}): boolean {
  return !status.app.running && !status.runtime.reachable
}
