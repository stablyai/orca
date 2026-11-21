import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveSpawn } from './spawn-resolution'
import { hasSpawnObserver, notifySpawnObserver } from './spawn-observer'
import { spawnNativeProcess } from './native-process-spawn'
import type { NativeExecutableSelection } from './native-executable-resolution'
import type { PipedProcessSpec, ProcessSpec } from './process-spec'
import { fdClosingLaunch, retargetSpawnError, watchFdClosingExec } from './fd-closing-exec-launch'

/** Callers own stream error handling; unhandled stream errors can crash the host process.
 * A selection from resolveAsync spares this thread the synchronous PATH lookup. */
export function spawnProcess(
  spec: PipedProcessSpec,
  selection?: NativeExecutableSelection
): ChildProcessWithoutNullStreams
export function spawnProcess(spec: ProcessSpec, selection?: NativeExecutableSelection): ChildProcess
export function spawnProcess(
  spec: ProcessSpec,
  selection?: NativeExecutableSelection
): ChildProcess {
  const resolved = resolveSpawn(spec, process.platform)
  const observe = hasSpawnObserver() ? notifySpawnObserver : undefined
  const launch = spec.closeInheritedFds
    ? fdClosingLaunch(resolved.file, resolved.args, resolved.options)
    : null
  if (launch) {
    const options = { ...resolved.options, env: launch.env, stdio: launch.stdio }
    let child: ChildProcess
    try {
      child = spawnNativeProcess(launch.file, launch.args, options, undefined, observe)
    } catch (error) {
      throw retargetSpawnError(error, launch)
    }
    return watchFdClosingExec(child, launch)
  }
  return spawnNativeProcess(
    resolved.file,
    resolved.args,
    resolved.options,
    selection?.program === resolved.file ? selection : undefined,
    observe
  )
}
