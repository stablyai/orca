import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { endSubprocessStdin } from '../../../shared/subprocess-stdin-write'
import { runProcess } from '../../../shared/child-process/run-process'
import type { WslProcessGroupTermination } from '../wsl-process-group-termination'
import { createAbortError } from './abort-error'
import { killSpawnedCommandTree } from './spawned-command-tree-kill'
import { DEFAULT_GIT_MAX_BUFFER } from './git-exec-options'

type ExecFileCaptureOptions = Omit<ExecFileOptions, 'timeout'> & {
  timeout?: number
  stdin?: string
  terminationBarrier?: boolean
}

const GIT_TERMINATION_BARRIER_FALLBACK_TIMEOUT_MS = 2_147_000_000

export async function execFileCaptureToTermination(
  command: string,
  args: string[],
  options: ExecFileCaptureOptions,
  termination?: WslProcessGroupTermination
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  const result = await runProcess({
    program: command,
    args,
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
    env: options.env,
    timeoutMs: options.timeout ?? GIT_TERMINATION_BARRIER_FALLBACK_TIMEOUT_MS,
    maxOutputBytes: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
    signal: options.signal,
    terminationBarrier: termination ?? true,
    ...(options.stdin === undefined ? {} : { input: options.stdin })
  })
  const stdout = options.encoding === 'buffer' ? Buffer.from(result.stdout) : result.stdout
  const cleanStderr = termination?.stripControlOutput(result.stderr) ?? result.stderr
  const stderr = options.encoding === 'buffer' ? Buffer.from(cleanStderr) : cleanStderr
  if (result.code === 0 && !result.timedOut && !options.signal?.aborted) {
    return { stdout, stderr }
  }
  const error = new Error(
    result.timedOut
      ? `${command} timed out.`
      : options.signal?.aborted
        ? 'The operation was aborted.'
        : cleanStderr.trim() || `${command} exited with ${result.code}.`
  )
  if (options.signal?.aborted) {
    error.name = 'AbortError'
  }
  throw Object.assign(error, {
    code: result.code,
    killed: result.timedOut || result.signal !== null || options.signal?.aborted === true,
    signal: result.signal,
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

export function execFileCapture(
  command: string,
  args: string[],
  options: ExecFileCaptureOptions
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError())
      return
    }

    let settled = false
    let terminating = false
    let child: ChildProcess | null = null
    let timer: NodeJS.Timeout | null = null
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
      child = execFile(
        command,
        args,
        {
          cwd: options.cwd,
          // Why: git.exe is console-subsystem and Orca's main process owns no
          // console, so every spawn without this flashes a conhost that takes
          // foreground. Git runs on nearly every interaction (#14543).
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
      finish(error instanceof Error ? error : new Error(String(error)))
      return
    }

    child.once('error', (error) => {
      if (!terminating) {
        finish(error)
      }
    })

    if (options.stdin !== undefined) {
      endSubprocessStdin(child.stdin, options.stdin)
    }

    // Why: Node's timeout waits forever on signal-ignoring CLIs; enforce our own deadline with bounded tree cleanup.
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        if (settled || terminating) {
          return
        }
        terminating = true
        const timeoutError = new Error(`${command} timed out.`)
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
