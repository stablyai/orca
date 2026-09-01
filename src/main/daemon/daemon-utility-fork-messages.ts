/**
 * Wire types between the daemon-forking main process and the utility-process
 * launcher shim. Both sides bundle separately, so the contract lives alone.
 */

export type UtilityDaemonForkSpec = {
  /** Absolute path to daemon-entry.js (unpacked in packaged builds). */
  entryPath: string
  args: readonly string[]
  cwd: string
  /** Full daemon environment, composed by main — never placed in argv. */
  env: NodeJS.ProcessEnv
  /** Binary to run as plain Node; the relocated Windows host when staged. */
  execPath: string
}

export type DaemonShimDownMessage =
  | { kind: 'spawn'; spec: UtilityDaemonForkSpec }
  | { kind: 'release' }

export type DaemonShimUpMessage =
  | { kind: 'shim-ready' }
  | { kind: 'spawned'; pid: number }
  | { kind: 'spawn-error'; message: string }
  | { kind: 'daemon-message'; message: unknown }
  | { kind: 'daemon-stderr'; text: string }
  | { kind: 'daemon-error'; message: string }
  | { kind: 'daemon-exit'; code: number | null; signal: NodeJS.Signals | null }
