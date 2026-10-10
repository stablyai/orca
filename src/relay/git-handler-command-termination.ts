import {
  signalProcessTree,
  forceTerminateProcessTree
} from '@orca/process-host/process-tree-termination'
import type { ProcessTerminationBarrier } from '@orca/process-host/process-spec'
import { runProcess } from '@orca/process-host'
import { GitAdmissionScheduler } from '../shared/git-admission-scheduler'
import type { GitAdmissionRequest } from '../shared/git-admission-state'
import { gitCommandTimeoutMs } from '../shared/git-command-timeout'

export const MAX_GIT_BUFFER = 10 * 1024 * 1024
let scheduler = new GitAdmissionScheduler()

export function _resetRelayGitAdmissionForTests(replacement = new GitAdmissionScheduler()): void {
  scheduler = replacement
}

export const acquireRelayGitAdmission = (request: GitAdmissionRequest) => scheduler.acquire(request)

type GitTerminationOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
  captureStdoutAsBytes?: boolean
  outputCapture?: 'tail'
  observeStderr?: ProcessTerminationBarrier['observeStderr']
}

export async function runGitToTermination(
  args: string[],
  options: GitTerminationOptions,
  stdin: string | undefined
): Promise<{ stdout: string; stderr: string; stdoutBytes?: Buffer }> {
  const grant = await acquireRelayGitAdmission({
    args,
    cwd: options.cwd ?? '.',
    signal: options.signal
  })
  // A rejected capture can precede child termination; the child owns the grant.
  const result = await runProcess(
    {
      program: 'git',
      args,
      cwd: options.cwd,
      env: options.env,
      timeoutMs: gitCommandTimeoutMs(args, options.timeout) ?? null,
      maxOutputBytes: options.maxBuffer ?? MAX_GIT_BUFFER,
      captureStdoutAsBytes: options.captureStdoutAsBytes,
      killOnOutputLimit: options.outputCapture !== 'tail',
      signal: options.signal,
      terminationBarrier: options.observeStderr
        ? {
            observeStderr: options.observeStderr,
            signal: signalProcessTree,
            force: forceTerminateProcessTree
          }
        : true,
      onChildTerminated: grant.release,
      ...(stdin === undefined ? {} : { input: stdin })
    },
    options.outputCapture
  )
  const outputExceeded = result.outputTruncated === true && options.outputCapture !== 'tail'
  if (
    result.code === 0 &&
    !result.signal &&
    !result.timedOut &&
    !options.signal?.aborted &&
    !outputExceeded
  ) {
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.stdoutBytes ? { stdoutBytes: result.stdoutBytes } : {})
    }
  }
  const error = new Error(
    outputExceeded
      ? 'git output exceeded maxBuffer.'
      : result.timedOut
        ? `git ${args[0] ?? 'command'} timed out.`
        : options.signal?.aborted
          ? 'The operation was aborted.'
          : result.stderr.trim() || `git ${args[0] ?? 'command'} failed.`
  )
  if (options.signal?.aborted) {
    error.name = 'AbortError'
  }
  throw Object.assign(error, {
    code: outputExceeded ? 'ENOBUFS' : result.code,
    timedOut: result.timedOut,
    killed: result.timedOut || result.signal !== null || options.signal?.aborted === true,
    signal: result.signal,
    stdout: result.stdoutBytes ?? result.stdout,
    stderr: result.stderr
  })
}
