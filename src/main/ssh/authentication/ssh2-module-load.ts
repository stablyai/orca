import type * as Ssh2 from 'ssh2'

/** Load ssh2 on first use; requiring it at startup blocks the main process before any window (#35731). */
export function loadSsh2(): typeof Ssh2 {
  return require('ssh2')
}

/** Load ssh2 during startup for profiles with saved SSH targets, matching their previous timing. */
export function preloadSsh2(): void {
  try {
    loadSsh2()
  } catch (error) {
    // A broken ssh2 install surfaces at connect time instead of crashing startup.
    console.warn('[ssh] could not preload ssh2:', error)
  }
}
