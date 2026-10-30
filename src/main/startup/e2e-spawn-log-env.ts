import { E2E_SPAWN_LOG_ENV } from '@orca/process-host/spawn-observer'

/**
 * The e2e spawn log records full argv, which can include tokens; tests only. Outside e2e mode
 * (no ORCA_E2E_USER_DATA_DIR) it is dropped before anything spawns, so no daemon, PTY or agent
 * inherits it and a stray variable never writes a user's command lines to disk.
 */
export function dropE2eSpawnLogOutsideE2e(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.ORCA_E2E_USER_DATA_DIR) {
    delete env[E2E_SPAWN_LOG_ENV]
  }
}
