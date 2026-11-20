import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveSpawn } from './spawn-resolution'
import { hasSpawnObserver, notifySpawnObserver } from './spawn-observer'
import { spawnNativeProcess } from './native-process-spawn'
import type { PipedProcessSpec, ProcessSpec } from './process-spec'
import { fdClosingLaunch, watchFdClosingExec } from './fd-closing-exec-launch'

/** Callers own stream error handling; unhandled stream errors can crash the host process. */
export function spawnProcess(spec: PipedProcessSpec): ChildProcessWithoutNullStreams
export function spawnProcess(spec: ProcessSpec): ChildProcess
export function spawnProcess(spec: ProcessSpec): ChildProcess {
  const resolved = resolveSpawn(spec, process.platform)
  const observe = hasSpawnObserver() ? notifySpawnObserver : undefined
  const launch = spec.closeInheritedFds
    ? fdClosingLaunch(resolved.file, resolved.args, resolved.options)
    : null
  if (launch) {
    const options = { ...resolved.options, env: launch.env, stdio: launch.stdio }
    return watchFdClosingExec(
      spawnNativeProcess(launch.file, launch.args, options, undefined, observe),
      launch
    )
  }
  return spawnNativeProcess(resolved.file, resolved.args, resolved.options, undefined, observe)
}
