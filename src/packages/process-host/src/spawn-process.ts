import {
  spawn as nodeSpawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from 'node:child_process'
import { resolveSpawn, type ResolvedSpawn } from './spawn-resolution'
import { hasSpawnObserver, notifySpawnObserver } from './spawn-observer'
import type { PipedProcessSpec, ProcessSpec } from './process-spec'
import { spawnNativeProcess } from './native-process-spawn'

type SpawnOwnership = {
  onChild: (child: ChildProcess) => void
  onNoStart: () => void
}

type OwnedProcessSpec = Pick<ProcessSpec, 'program' | 'args' | 'cwd' | 'env' | 'detached'>

/** Ignore stdio excludes post-spawn pipe/IPC setup from the native no-start proof. */
export function spawnOwnedProcess(spec: OwnedProcessSpec, ownership: SpawnOwnership): ChildProcess {
  const resolved = resolveSpawn(
    {
      program: spec.program,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      detached: spec.detached,
      stdio: 'ignore'
    },
    process.platform
  )
  return spawnResolvedProcess(resolved, ownership)
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

function spawnResolvedProcess(resolved: ResolvedSpawn, ownership?: SpawnOwnership): ChildProcess {
  const { file, args, options } = resolved
  const argv = [...args]
  // uv_spawn blocks the calling thread; measure that block for diagnostics.
  const spawnStartedAt = hasSpawnObserver() ? performance.now() : null
  let result: { child: ChildProcess } | { error: unknown }
  try {
    result = { child: nodeSpawn(file, argv, options) }
  } catch (error) {
    result = { error }
  }
  if ('error' in result) {
    ownership?.onNoStart()
    throw result.error
  }
  const { child } = result
  ownership?.onChild(child)
  if (spawnStartedAt !== null) {
    notifySpawnObserver(file, args, performance.now() - spawnStartedAt)
  }
  return child
}
