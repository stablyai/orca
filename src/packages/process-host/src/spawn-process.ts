import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveSpawn } from './spawn-resolution'
import { hasSpawnObserver, notifySpawnObserver } from './spawn-observer'
import { spawnNativeProcess } from './native-process-spawn'
import type { PipedProcessSpec, ProcessSpec } from './process-spec'
import { fdClosingLaunch } from './fd-closing-exec-launch'

/** Callers own stream error handling; unhandled stream errors can crash the host process. */
export function spawnProcess(spec: PipedProcessSpec): ChildProcessWithoutNullStreams
export function spawnProcess(spec: ProcessSpec): ChildProcess
export function spawnProcess(spec: ProcessSpec): ChildProcess {
  const resolved = resolveSpawn(spec, process.platform)
  const launch = fdClosingLaunch(spec.fdClosingExec, resolved.file, resolved.args, resolved.options)
  return spawnNativeProcess(
    launch?.file ?? resolved.file,
    launch?.args ?? resolved.args,
    resolved.options,
    undefined,
    hasSpawnObserver() ? notifySpawnObserver : undefined
  )
}
