import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../../diagnostics/main-thread-churn-probe'
import { endSubprocessStdin } from '../../../../shared/subprocess-stdin-write'
import { createPosixGroupTermination } from '@orca/process-host/posix-group-termination'
import { nativeExecutableResolver } from '@orca/process-host/native-executable-resolution'
import { spawnNativeProcess } from '@orca/process-host/native-process-spawn'
import { resolveSelectedLocalCommand } from '../../../ipc/command-path/command-path-resolver'
import { createAbortError } from './abort-error'
import { killSpawnedCommandTree } from './spawned-command-tree-kill'
import { DEFAULT_GIT_MAX_BUFFER } from '../git-exec-options'
import type { GitAdmissionTier } from '../../../../shared/rpc-contract/source-control/git-admission-tier-params'

import { spawnedExecFile, workerExecFile } from './worker-exec-file'
import type { WorkerThreadChildProcess } from '../../../worker-thread-child-process/worker-thread-child-process'

export type ExecFileCaptureOptions = Omit<ExecFileOptions, 'timeout'> & {
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
  /** Native Git only: launch an owned group and retain it after abnormal stop until proof. */
  ownedPosixGroup?: boolean
}

export { execFileCaptureToTermination } from './exec-file-capture-to-termination'

function emptyExecFileOutput(options: ExecFileCaptureOptions): string | Buffer {
  return options.encoding === 'buffer' || options.encoding === null ? Buffer.alloc(0) : ''
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

    let readCapture: (() => { stdout: string | Buffer; stderr: string | Buffer }) | undefined
    let settled = false
    let terminating = false
    let child: ChildProcess | WorkerThreadChildProcess | null = null
    let groupTermination: ReturnType<typeof createPosixGroupTermination> | undefined
    const ownedPosixGroup = options.ownedPosixGroup === true && process.platform !== 'win32'
    const useWorker = options.spawnOnWorkerThread === true && process.platform === 'darwin'
    const deadline =
      options.timeout && options.timeout > 0 ? performance.now() + options.timeout : null
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
    const stop = (error: Error): void => {
      if (settled || terminating) {
        return
      }
      terminating = true
      if (!child) {
        terminating = false
        reportChildTerminated()
        finish(error)
        return
      }
      if (ownedPosixGroup) {
        if ('stopOwnedGroup' in child) {
          child.stopOwnedGroup()
        } else {
          void groupTermination?.stop()
        }
        const output = isExecFileResultObject(error) ? error : readCapture?.()
        finish(error, output?.stdout, output?.stderr)
        return
      }
      void killSpawnedCommandTree(child).then(() => {
        terminating = false
        finish(error)
      })
    }

    const onAbort = (): void => stop(createAbortError())
    const onDeadline = (): void => {
      if (!settled && !terminating) {
        options.onDeadlineKill?.()
        stop(options.createTimeoutError?.() ?? new Error(`${command} timed out.`))
      }
    }
    // Lookup is part of the deadline; cancellation must settle even before there is a child.
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(onDeadline, options.timeout)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) {
      onAbort()
    }

    const launch = async (): Promise<void> => {
      try {
        if (settled) {
          return
        }
        const spawnStartedAt = performance.now()
        // Why: our abort listener owns tree cleanup; Node's signal handler could kill wsl.exe before taskkill sees its children.
        const captureOptions = {
          cwd: options.cwd,
          // Hide console-subsystem children so frequent Git calls cannot flash or take focus.
          windowsHide: true,
          encoding: options.encoding,
          maxBuffer: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
          env: options.env,
          ...(ownedPosixGroup
            ? {
                detached: true,
                ownedPosixGroup: true,
                onOverflow: stop,
                onError: stop,
                ...(process.platform !== 'darwin'
                  ? { errorCommand: `${command} ${args.join(' ')}` }
                  : {}),
                onCapture: (read: () => { stdout: string | Buffer; stderr: string | Buffer }) => {
                  readCapture = read
                }
              }
            : {})
        }
        const complete = (
          error: Error | null,
          stdout: string | Buffer,
          stderr: string | Buffer
        ): void => {
          if (terminating) {
            return
          }
          if (!error && stderr === undefined && isExecFileResultObject(stdout)) {
            finish(null, stdout.stdout, stdout.stderr)
            return
          }
          finish(error, stdout, stderr)
        }
        if (!useWorker && process.platform === 'darwin') {
          const program = resolveSelectedLocalCommand(command, {
            env: options.env,
            cwd: typeof options.cwd === 'string' ? options.cwd : undefined
          })
          const selection = await nativeExecutableResolver.resolveAsync(program, options.env)
          if (deadline !== null && performance.now() >= deadline) {
            onDeadline()
          }
          if (settled) {
            return
          }
          child = spawnedExecFile(command, captureOptions, complete, () =>
            spawnNativeProcess(
              program,
              args,
              { ...captureOptions, argv0: command },
              selection,
              recordSubprocessSpawn
            )
          )
        } else {
          child = useWorker
            ? workerExecFile(command, args, captureOptions, complete)
            : ownedPosixGroup
              ? spawnedExecFile(command, captureOptions, complete, () =>
                  spawnNativeProcess(
                    command,
                    args,
                    captureOptions,
                    undefined,
                    recordSubprocessSpawn
                  )
                )
              : execFile(command, args, captureOptions, complete)
          if (useWorker || !ownedPosixGroup) {
            recordSubprocessSpawn(command, args, performance.now() - spawnStartedAt)
          }
        }
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
      if (ownedPosixGroup) {
        if ('stopOwnedGroup' in child) {
          child.once('group-terminated', reportChildTerminated)
          child.once('close', () => {
            if (!terminating) {
              reportChildTerminated()
            }
          })
        } else {
          groupTermination = createPosixGroupTermination(child, reportChildTerminated)
          child.once('close', groupTermination.close)
        }
      } else {
        child.once('close', reportChildTerminated)
      }
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
    }
    void launch().catch((error: unknown) => {
      if (!child) {
        reportChildTerminated()
      }
      finish(error instanceof Error ? error : new Error(String(error)))
    })
  })
}
