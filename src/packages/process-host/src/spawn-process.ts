import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveSpawn } from './spawn-resolution'
import { hasSpawnObserver, notifySpawnObserver } from './spawn-observer'
import { spawnNativeProcess } from './native-process-spawn'
import type { PipedProcessSpec, ProcessSpec } from './process-spec'

/** Callers own stream error handling; unhandled stream errors can crash the host process. */
export function spawnProcess(spec: PipedProcessSpec): ChildProcessWithoutNullStreams
export function spawnProcess(spec: ProcessSpec): ChildProcess
export function spawnProcess(spec: ProcessSpec): ChildProcess {
  const resolved = resolveSpawn(spec, process.platform)
  return spawnNativeProcess(
    resolved.file,
    resolved.args,
    resolved.options,
    undefined,
    hasSpawnObserver() ? notifySpawnObserver : undefined
  )
}
