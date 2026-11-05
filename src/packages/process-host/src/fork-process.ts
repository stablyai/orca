// All host process creation goes through this package; callers cannot import child_process directly.
import {
  fork as nodeFork,
  type ForkOptions,
  type SpawnOptions as NodeSpawnOptions
} from 'node:child_process'
import type { SpawnedProcess } from './process-spec'

// Preserve fork semantics for module resolution, execPath overrides, and inherited execArgv.
export type ForkSpec = {
  modulePath: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Keep the child in its own POSIX process group so it outlives this process. */
  detached?: boolean
  /** Must keep an `'ipc'` slot; without one the child gets no channel and cannot `send`. */
  stdio?: NodeSpawnOptions['stdio']
  execPath?: string
  /** Replaces the inherited process.execArgv (Node/V8 flags placed before the module path). */
  execArgv?: readonly string[]
}

export function forkProcess(spec: ForkSpec): SpawnedProcess {
  const options: ForkOptions = {
    cwd: spec.cwd,
    env: spec.env,
    detached: spec.detached,
    stdio: spec.stdio,
    // Node treats an explicit undefined execPath differently from an absent key.
    ...(spec.execPath ? { execPath: spec.execPath } : {}),
    ...(spec.execArgv ? { execArgv: [...spec.execArgv] } : {})
  }
  // Node forwards this undocumented fork option to spawn, preventing console flashes on Windows.
  return nodeFork(
    spec.modulePath,
    [...(spec.args ?? [])],
    Object.assign({}, options, { windowsHide: true })
  )
}
