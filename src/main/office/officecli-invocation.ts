/**
 * Running `officecli` on the lane that owns the document.
 *
 * Every child starts through `src/shared/child-process/` or `runWslProcess`; a ratchet test
 * refuses a direct `node:child_process` import from here. Nothing in this file builds a shell
 * string — argv arrays only, so a document path with a space, a quote or a `$` stays one argument.
 *
 * What this file deliberately does NOT do: call `officecli close` after a render. `view` leaves a
 * warm `__resident-serve__` process holding the document, which self-exits after roughly two
 * minutes idle (measured on 1.0.148). `close` would end it early — but it also flushes in-memory
 * edits, so an agent mid-batch would have its work written and its warm resident killed by
 * somebody else's preview. The tool's own idle teardown is the right owner.
 */
import {
  runProcess,
  spawnProcess,
  type ChildProcessHandle
} from '../../shared/child-process/run-process'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { runWslProcess } from '../wsl/wsl-runner'
import { NATIVE_OFFICECLI_LANE, type OfficecliLane } from './officecli-lane'
import { resolveOfficecli } from './officecli-resolution'

export type OfficecliRun = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Distinguishes "the host has no binary" from "the binary ran and failed". */
export class OfficecliMissingError extends Error {
  constructor() {
    super('officecli is not installed on this execution host')
    this.name = 'OfficecliMissingError'
  }
}

export type OfficecliRunOptions = {
  lane?: OfficecliLane
  timeoutMs: number
  maxOutputBytes?: number
  signal?: AbortSignal
  cwd?: string
}

export async function runOfficecli(
  args: readonly string[],
  options: OfficecliRunOptions
): Promise<OfficecliRun> {
  const lane = options.lane ?? NATIVE_OFFICECLI_LANE
  const resolved = await resolveOfficecli(lane)
  if (!resolved.path) {
    throw new OfficecliMissingError()
  }
  if (lane.kind === 'wsl') {
    const result = await runWslProcess({
      program: resolved.path,
      args,
      distro: lane.distro,
      loginPath: 'preferred',
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes
    })
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut
    }
  }
  const result = await runProcess({
    program: resolved.path,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
    signal: options.signal
  })
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  }
}

/**
 * Start a long-lived `officecli` child (the watch server) and keep the handle.
 *
 * `detached` so the whole tree can be signalled at teardown: the watch process starts a resident
 * of its own, and killing only the root would leave that one holding the file.
 */
export async function spawnOfficecli(
  args: readonly string[],
  options: { lane?: OfficecliLane; cwd?: string; onTerminated?: () => void }
): Promise<ChildProcessHandle> {
  const lane = options.lane ?? NATIVE_OFFICECLI_LANE
  const resolved = await resolveOfficecli(lane)
  if (!resolved.path) {
    throw new OfficecliMissingError()
  }
  // WSL guests get the same treatment through wsl.exe, which propagates the signal to the guest
  // process it fronts; there is no separate guest-side spawn API to hold.
  const spawnSpec =
    lane.kind === 'wsl'
      ? {
          program: resolveWslExecutablePath(),
          args: buildWslExecArgs(lane.distro, [resolved.path, ...args])
        }
      : { program: resolved.path, args: [...args] }
  return spawnProcess({
    ...spawnSpec,
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    // stdio is piped by default; the watch server logs to stdout and nothing reads it, so drain
    // both streams to keep the pipe from filling and stalling the child.
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.onTerminated ? { onChildTerminated: options.onTerminated } : {})
  })
}
