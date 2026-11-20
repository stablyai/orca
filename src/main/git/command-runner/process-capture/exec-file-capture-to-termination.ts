import { WorktreeRemovalIdentityUnverifiableError } from '../../../../shared/worktree/removal/worktree-checkout-identity'
import { runProcess } from '@orca/process-host'
import type { ChildProcess } from 'node:child_process'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { resolveSelectedLocalCommand } from '../../../ipc/command-path/command-path-resolver'
import type { WslProcessGroupTermination } from './wsl-process-group-termination'
import { DEFAULT_GIT_MAX_BUFFER } from '../git-exec-options'
import { createAbortError } from './abort-error'
import { launchProcessSpecOnWindowsWorker } from './process-spec-worker-launch'
import type { ExecFileCaptureOptions } from './exec-file-capture'

const GIT_TERMINATION_BARRIER_FALLBACK_TIMEOUT_MS = 2_147_000_000

export async function execFileCaptureToTermination(
  command: string,
  args: string[],
  // Why: runProcess owns this child's streams; git-exec-file refuses onStderr with a barrier.
  options: Omit<ExecFileCaptureOptions, 'onStderr' | 'stdin'> & { stdin?: string | Uint8Array },
  termination?: WslProcessGroupTermination
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  // This route deletes inside WSL, where the worker can't check the checkout's identity: keep it.
  if (options.worktreeCheckoutGuard) {
    options.onChildTerminated?.()
    throw new WorktreeRemovalIdentityUnverifiableError()
  }
  // runProcess already reports spawn cost through spawnProcess.
  let program: string
  try {
    program = resolveSelectedLocalCommand(command, {
      env: options.env,
      cwd: typeof options.cwd === 'string' ? options.cwd : undefined
    })
  } catch (error) {
    options.onChildTerminated?.()
    throw error
  }
  if (options.canStart?.() === false) {
    options.onChildTerminated?.()
    throw createAbortError()
  }
  const captureBytes = options.encoding === 'buffer'
  // runProcess and a lost worker's tree kill can both report; callers hear it once.
  let terminated = false
  const reportTerminated = (): void => {
    if (!terminated) {
      terminated = true
      options.onChildTerminated?.()
    }
  }
  // A worker loss during a stop could otherwise force the guest group twice, each a wsl.exe launch.
  let guestForce: Promise<boolean> | undefined
  const barrier = termination
    ? { ...termination, force: (child: ChildProcess) => (guestForce ??= termination.force(child)) }
    : true
  const pending = runProcess({
    program,
    args,
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
    env: options.env,
    timeoutMs: options.timeout ?? GIT_TERMINATION_BARRIER_FALLBACK_TIMEOUT_MS,
    maxOutputBytes: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
    captureStdoutAsBytes: captureBytes,
    captureStderrAsBytes: captureBytes,
    signal: options.signal,
    terminationBarrier: barrier,
    onChildTerminated: reportTerminated,
    ...(options.spawnOnWorkerThread === false
      ? {}
      : {
          launch: (spec: ProcessSpec) =>
            launchProcessSpecOnWindowsWorker(
              spec,
              options.onWorkerLost,
              reportTerminated,
              options.workerLossEndsLifetime === true || !options.onChildTerminated
            )
        }),
    ...(options.stdin === undefined ? {} : { input: options.stdin })
  })
  const result = await pending
  const stdout = captureBytes ? (result.stdoutBytes ?? Buffer.alloc(0)) : result.stdout
  const stderrBytes = result.stderrBytes ?? Buffer.alloc(0)
  const stderr = captureBytes
    ? termination
      ? // Why: Latin-1 strips ASCII control markers without changing arbitrary bytes.
        Buffer.from(termination.stripControlOutput(stderrBytes.toString('latin1')), 'latin1')
      : stderrBytes
    : (termination?.stripControlOutput(result.stderr) ?? result.stderr)
  if (
    result.code === 0 &&
    !result.timedOut &&
    !result.outputTruncated &&
    !options.signal?.aborted
  ) {
    return { stdout, stderr }
  }
  if (result.timedOut && !options.signal?.aborted) {
    options.onDeadlineKill?.()
  }
  const cleanStderr = typeof stderr === 'string' ? stderr : stderr.toString('utf8')
  const error = result.timedOut
    ? (options.createTimeoutError?.() ?? new Error(`${command} timed out.`))
    : new Error(
        options.signal?.aborted
          ? 'The operation was aborted.'
          : result.outputTruncated
            ? // Reject clipped output: JSON/JSONL consumers could otherwise accept an incomplete result.
              `${command} produced more than ${options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER} bytes of output.`
            : cleanStderr.trim() || `${command} exited with ${result.code}.`
      )
  if (options.signal?.aborted) {
    error.name = 'AbortError'
  }
  throw Object.assign(error, {
    code: result.code,
    killed: result.timedOut || result.signal !== null || options.signal?.aborted === true,
    signal: result.signal,
    outputTruncated: result.outputTruncated,
    stdout,
    stderr
  })
}
