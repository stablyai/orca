import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { endSubprocessStdin } from '../../../shared/subprocess-stdin-write'
import { runProcess } from '@orca/process-host'
import { resolveSelectedLocalCommand } from '../../ipc/command-path-resolver'
import type { WslProcessGroupTermination } from '../wsl-process-group-termination'
import { createAbortError } from './abort-error'
import { killSpawnedCommandTree } from './spawned-command-tree-kill'
import { DEFAULT_GIT_MAX_BUFFER } from './git-exec-options'
import type { GitAdmissionTier } from './git-exec-options'
import { workerExecFile } from './worker-exec-file'
import type { WorkerThreadChildProcess } from '../../worker-thread-child-process/worker-thread-child-process'

type ExecFileCaptureOptions = Omit<ExecFileOptions, 'timeout'> & {
  timeout?: number
  stdin?: string
  terminationBarrier?: boolean
  onChildTerminated?: () => void
  admissionTier?: GitAdmissionTier
  createTimeoutError?: () => Error
  /** Called once when the deadline — not an abort — is what ended the process. */
  onDeadlineKill?: () => void
  onStderr?: (chunk: string) => void
  spawnOnWorkerThread?: boolean
}

const GIT_TERMINATION_BARRIER_FALLBACK_TIMEOUT_MS = 2_147_000_000

export async function execFileCaptureToTermination(
  command: string,
  args: string[],
  // Why: runProcess owns this child's streams; git-exec-file refuses onStderr with a barrier.
  options: Omit<ExecFileCaptureOptions, 'onStderr'>,
  termination?: WslProcessGroupTermination
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
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
  const captureBytes = options.encoding === 'buffer'
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
    terminationBarrier: termination ?? true,
    onChildTerminated: options.onChildTerminated,
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

function emptyExecFileOutput(options: ExecFileCaptureOptions): string | Buffer {
  return options.encoding === 'buffer' ? Buffer.alloc(0) : ''
}

function isExecFileResultObject(
  value: unknown
): value is { stdout: string | Buffer; stderr: string | Buffer } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Buffer.isBuffer(value) &&
    'stdout' in value &&
    'stderr' in value
  )
}

/** A second, passive stderr listener: execFile still captures every byte. */
function observeStderr(
  child: ChildProcess | WorkerThreadChildProcess,
  observer: (chunk: string) => void
): void {
  const onData = (chunk: string | Buffer): void => {
    try {
      observer(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    } catch (error) {
      // Detach throwing observers so stream callbacks cannot crash main.
      child.stderr?.off('data', onData)
      console.warn('git stderr observer failed; detaching it', error)
    }
  }
  child.stderr?.on('data', onData)
}

export function execFileCapture(
  command: string,
  args: string[],
  options: ExecFileCaptureOptions
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      options.onChildTerminated?.()
      reject(createAbortError())
      return
    }

    let settled = false
    let terminating = false
    let child: ChildProcess | WorkerThreadChildProcess | null = null
    const useWorker = options.spawnOnWorkerThread === true && process.platform === 'darwin'
    let timer: NodeJS.Timeout | null = null
    let terminationReported = false
    const reportChildTerminated = (): void => {
      if (terminationReported) {
        return
      }
      terminationReported = true
      options.onChildTerminated?.()
    }
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      options.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (
      error: Error | null,
      stdout: string | Buffer = emptyExecFileOutput(options),
      stderr: string | Buffer = emptyExecFileOutput(options)
    ): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error) {
        const enriched = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer }
        enriched.stdout ??= stdout
        enriched.stderr ??= stderr
        reject(enriched)
        return
      }
      resolve({ stdout, stderr })
    }
    const onAbort = (): void => {
      if (settled || terminating) {
        return
      }
      terminating = true
      const abortError = createAbortError()
      if (!child) {
        terminating = false
        finish(abortError)
        return
      }
      void killSpawnedCommandTree(child).then(() => {
        terminating = false
        finish(abortError)
      })
    }

    try {
      const spawnStartedAt = performance.now()
      // Why: our abort listener owns tree cleanup; Node's signal handler could kill wsl.exe before taskkill sees its children.
      const capture = useWorker ? workerExecFile : execFile
      child = capture(
        command,
        args,
        {
          cwd: options.cwd,
          // Hide console-subsystem children so frequent Git calls cannot flash or take focus.
          windowsHide: true,
          encoding: options.encoding,
          maxBuffer: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
          env: options.env
        },
        (error, stdout, stderr) => {
          if (terminating) {
            return
          }
          if (!error && stderr === undefined && isExecFileResultObject(stdout)) {
            finish(null, stdout.stdout, stdout.stderr)
            return
          }
          finish(error, stdout, stderr)
        }
      )
      recordSubprocessSpawn(command, args, performance.now() - spawnStartedAt)
    } catch (error) {
      reportChildTerminated()
      finish(error instanceof Error ? error : new Error(String(error)))
      return
    }

    child.once('error', (error) => {
      // A lost worker may have spawned a child whose PID never reached us; only close proves termination.
      if (!useWorker && !child?.pid) {
        reportChildTerminated()
      }
      if (!terminating) {
        finish(error)
      }
    })
    child.once('close', reportChildTerminated)
    if (options.onStderr) {
      observeStderr(child, options.onStderr)
    }

    // Non-interactive signers must see EOF instead of waiting on an open pipe.
    if ('id' in child) {
      if (options.stdin !== undefined) {
        child.stdin.write(options.stdin)
      }
      child.stdin.end()
    } else {
      endSubprocessStdin(child.stdin, options.stdin ?? '')
    }

    // Why: Node's timeout waits forever on signal-ignoring CLIs; enforce our own deadline with bounded tree cleanup.
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        if (settled || terminating) {
          return
        }
        terminating = true
        const timeoutError = options.createTimeoutError?.() ?? new Error(`${command} timed out.`)
        if (!child) {
          terminating = false
          finish(timeoutError)
          return
        }
        void killSpawnedCommandTree(child).then(() => {
          terminating = false
          finish(timeoutError)
        })
      }, options.timeout)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
