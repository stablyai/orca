import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveSpawn } from './spawn-resolution'
import { hasSpawnObserver, notifySpawnObserver } from './spawn-observer'
import { spawnNativeProcess } from './native-process-spawn'
import type {
  BufferedProcessChild,
  BufferedProcessSpawn,
  BufferedProcessSpawner,
  PipedProcessSpec,
  ProcessSpec
} from './process-spec'

let bufferedProcessSpawner: BufferedProcessSpawner | null = null

/** Host injection for buffered runs only; undefined from the spawner keeps the native path. */
export function setBufferedProcessSpawner(spawner: BufferedProcessSpawner | null): void {
  bufferedProcessSpawner = spawner
}

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

export function selectBufferedProcessSpawn(spec: ProcessSpec): {
  child: BufferedProcessChild
  hosted: BufferedProcessSpawn | undefined
} {
  const hosted = bufferedProcessSpawner?.(spec)
  const child = hosted?.child ?? spawnProcess(spec)
  return { child, hosted }
}
