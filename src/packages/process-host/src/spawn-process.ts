import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveSpawn } from './spawn-resolution'
import { hasSpawnObserver, notifySpawnObserver } from './spawn-observer'
import { spawnNativeProcess } from './native-process-spawn'
import type { NativeExecutableSelection } from './native-executable-resolution'
import type { LaunchedProcess, PipedProcessSpec, ProcessSpec } from './process-spec'

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
  return spawnNativeProcess(
    resolved.file,
    resolved.args,
    resolved.options,
    selection?.program === resolved.file ? selection : undefined,
    hasSpawnObserver() ? notifySpawnObserver : undefined
  )
}

export type ProcessLauncher = (
  spec: ProcessSpec,
  outputCapture?: 'head' | 'tail'
) => LaunchedProcess | null

// Main installs this; daemon, relay, and CLI cannot depend on main code.
let defaultLauncher: ProcessLauncher | null = null

/** runProcess uses it for specs without their own launch; returning null spawns on this thread. */
export function setDefaultProcessLauncher(next: ProcessLauncher | null): void {
  defaultLauncher = next
}

export function launchWithDefaultProcessLauncher(
  spec: ProcessSpec,
  outputCapture: 'head' | 'tail' = 'head'
): LaunchedProcess | null {
  return spec.launch
    ? spec.launch(spec, outputCapture)
    : (defaultLauncher?.(spec, outputCapture) ?? null)
}

/** Best-effort root termination; tree termination is handled separately. */
export function terminateChild(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}
