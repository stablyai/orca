import { execFile, type ChildProcess, type ExecFileOptions } from 'node:child_process'
import { recordSubprocessSpawn } from '../../../diagnostics/main-thread-churn-probe'
import { endSubprocessStdin } from '../../../../shared/process-streams/subprocess-stdin-write'
import { createPosixGroupTermination } from '@orca/process-host/posix-group-termination'
import { nativeExecutableResolver } from '@orca/process-host/native-executable-resolution'
import { spawnNativeProcess } from '@orca/process-host/native-process-spawn'
import { resolveSelectedLocalCommand } from '../../../ipc/command-path/command-path-resolver'
import { createAbortError } from './abort-error'
import { endAbandonedWorkerChild, killSpawnedCommandTree } from './spawned-command-tree-kill'
import { DEFAULT_GIT_MAX_BUFFER } from '../git-exec-options'
import type { GitAdmissionTier } from '../../../../shared/rpc-contract/source-control/git-admission-tier-params'

import {
  capturesOnWorker,
  keepsMainFdsOut,
  observeCapturedStderr,
  spawnedExecFile,
  spawnWithoutMainFds,
  withMainErrorText,
  workerExecFile
} from './worker-exec-file'
import { emptyExecFileOutput, isExecFileResultObject } from './exec-file-result-shape'
import {
  isAbandonedWorkerChildError,
  isWorkerChildStdinWriteError,
  type WorkerThreadChildProcess
} from '../../../worker-thread-child-process/worker-thread-child-process'

export type ExecFileCaptureOptions = Omit<ExecFileOptions, 'timeout'> & {
  timeout?: number
  stdin?: string
  terminationBarrier?: boolean
  /** Normal close or proven termination; mutation fences wait for this. */
  onChildTerminated?: () => void
  /** The child's worker died before its end was proven: capacity such as Git admission may return, fences may not. */
  onWorkerLost?: () => void
  /** The caller holds no mutation fence, so a lost worker ends the child's lifetime without proof (implied without onChildTerminated). */
  workerLossEndsLifetime?: boolean
  admissionTier?: GitAdmissionTier
  createTimeoutError?: () => Error
  /** Called once when the deadline — not an abort — is what ended the process. */
  onDeadlineKill?: () => void
  onStderr?: (chunk: string) => void
  /** False keeps a Windows launch on main; true waits for a cold worker instead of spawning on main meanwhile. */
  spawnOnWorkerThread?: boolean
  /** Native Git only: launch an owned group and retain it after abnormal stop until proof. */
  ownedPosixGroup?: boolean
  /** Rechecked synchronously at the spawn call, after any async executable resolution (so it keeps POSIX launches on main). */
  canStart?: () => boolean
}

export { execFileCaptureToTermination } from './exec-file-capture-to-termination'

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
    let useWorker = false
    // A busy Windows spawn worker must not hold the caller's deadline; decided once the launch picks its host.
    const callerOwnsDeadline = (): boolean => useWorker && process.platform === 'win32'
    const deadline =
      options.timeout && options.timeout > 0 ? performance.now() + options.timeout : null
    let timer: NodeJS.Timeout | null = null
    let terminationReported = false
    const reportChildTerminated = (): void => {
      if (!terminationReported) {
        terminationReported = true
        options.onChildTerminated?.()
      }
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
    const stop = (error: Error, settleBeforeCleanup = false): void => {
      if (settled) {
        return
      }
      if (terminating) {
        if (settleBeforeCleanup && callerOwnsDeadline()) {
          finish(error)
        }
        return
      }
      terminating = true
      if (!child) {
        reportChildTerminated()
        finish(error)
        return
      }
      if (ownedPosixGroup) {
        const output = isExecFileResultObject(error) ? error : readCapture?.()
        if ('stopOwnedGroup' in child) {
          child.stopOwnedGroup()
          // The caller settles now; output during group cleanup stays on the worker.
          child.discardOutput()
        } else {
          void groupTermination?.stop()
        }
        finish(error, output?.stdout, output?.stderr)
        return
      }
      void killSpawnedCommandTree(child).then(() => {
        terminating = false
        finish(error)
      })
      // A busy spawn worker must not hold the caller's deadline; close still owns termination proof.
      if (settleBeforeCleanup && callerOwnsDeadline()) {
        finish(error)
      }
    }

    const onAbort = (): void => stop(createAbortError(), true)
    const onDeadline = (): void => {
      if (!settled && (!terminating || callerOwnsDeadline())) {
        options.onDeadlineKill?.()
        stop(options.createTimeoutError?.() ?? new Error(`${command} timed out.`), true)
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
        useWorker = await capturesOnWorker(command, options)
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
          if (options.canStart?.() === false) {
            reportChildTerminated()
            finish(createAbortError())
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
          if (options.canStart?.() === false) {
            reportChildTerminated()
            finish(createAbortError())
            return
          }
          const workerOptions = withMainErrorText(captureOptions, command, args, stop)
          const linuxOnMain = keepsMainFdsOut()
          const spawnOnMain = (): ChildProcess =>
            linuxOnMain
              ? spawnWithoutMainFds(command, args, captureOptions)
              : spawnNativeProcess(command, args, captureOptions, undefined, recordSubprocessSpawn)
          child = useWorker
            ? workerExecFile(command, args, workerOptions, complete)
            : ownedPosixGroup || linuxOnMain
              ? spawnedExecFile(
                  command,
                  linuxOnMain ? workerOptions : captureOptions,
                  complete,
                  spawnOnMain
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

      child.on('error', (error) => {
        if (useWorker && isWorkerChildStdinWriteError(error)) {
          return
        }
        if (!useWorker && !child?.pid) {
          reportChildTerminated()
        } else if (child && isAbandonedWorkerChildError(error)) {
          endAbandonedWorkerChild(
            child,
            options.onWorkerLost,
            reportChildTerminated,
            options.workerLossEndsLifetime === true || !options.onChildTerminated,
            ownedPosixGroup
          )
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
        observeCapturedStderr(child, options.onStderr)
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
