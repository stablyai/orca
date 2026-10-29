import type { ChildProcess } from 'node:child_process'
import type { SystemSshCommandChannel } from './system-ssh-command'

export type ProcessResult = { label: string; stderr: string }

/** OpenSSH's own exit status for a connection-level failure, never the remote command's. */
const SYSTEM_SSH_TRANSPORT_EXIT_CODE = 255

export class SystemSshCommandExitError extends Error {
  constructor(
    label: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    signal?: NodeJS.Signals | null
  ) {
    const detail = exitCode === null ? `signal ${signal ?? 'unknown'}` : `exit ${exitCode}`
    super(`${label} failed (${detail}): ${stderr.trim()}`)
  }
}

/** The remote command, not OpenSSH, produced this exit. */
export function isHostAnsweredSystemSshExit(err: unknown): err is SystemSshCommandExitError {
  return (
    err instanceof SystemSshCommandExitError &&
    err.exitCode !== null &&
    err.exitCode !== SYSTEM_SSH_TRANSPORT_EXIT_CODE
  )
}

/** Bound hung remote consumers: PowerShell 5.1 can lose redirected stdin/EOF on an empty-pipe read at any size (#16432). */
export function waitForChannelClose(
  channel: SystemSshCommandChannel,
  label: string,
  timeoutMs?: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      channel.stderr.off('data', onStderrData)
      channel.off('error', onError)
      channel.off('close', onClose)
    }
    const settle = (fn: typeof resolve | typeof reject, val?: unknown): void => {
      cleanup()
      fn(val as never)
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        // Reject before close so its SIGTERM result cannot mask the diagnostic timeout.
        settle(
          reject,
          new Error(
            `${label} timed out after ${timeoutMs}ms with no response from the remote host: ${stderr.trim()}`
          )
        )
        channel.close()
      }, timeoutMs)
      timer.unref?.()
    }
    const onStderrData = (data: Buffer): void => {
      stderr += data.toString('utf-8')
    }
    const onError = (err: Error): void => {
      settle(reject, err)
    }
    const onClose = (code: number | null, signal?: NodeJS.Signals | null): void => {
      if (code !== 0) {
        settle(reject, new SystemSshCommandExitError(label, code, stderr, signal))
        return
      }
      settle(resolve)
    }

    channel.stderr.on('data', onStderrData)
    channel.on('error', onError)
    channel.on('close', onClose)
  })
}

/** `remote`: the process is ssh running a host command, so its exit status is the host's answer. */
export function waitForProcess(
  proc: ChildProcess,
  label: string,
  origin: 'local' | 'remote' = 'local'
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const cleanup = (): void => {
      proc.stderr?.off('data', onStderrData)
      proc.off('error', onError)
      proc.off('close', onClose)
    }
    const settle = (fn: typeof resolve | typeof reject, val: ProcessResult | Error): void => {
      cleanup()
      fn(val as never)
    }
    const onStderrData = (data: Buffer): void => {
      stderr += data.toString('utf-8')
    }
    const onError = (err: Error): void => {
      settle(reject, err)
    }
    const onClose = (code: number | null, signal?: NodeJS.Signals | null): void => {
      if (code !== 0) {
        settle(
          reject,
          origin === 'remote'
            ? new SystemSshCommandExitError(label, code, stderr, signal)
            : new Error(`${label} failed (exit ${code}): ${stderr.trim()}`)
        )
        return
      }
      settle(resolve, { label, stderr })
    }

    proc.stderr?.on('data', onStderrData)
    proc.on('error', onError)
    proc.on('close', onClose)
  })
}

export function killProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.killed) {
    return
  }
  try {
    proc.kill('SIGTERM')
  } catch {
    // Process may already be dead
  }
}

export async function awaitWithSystemSshAbort<T>(
  signal: AbortSignal | undefined,
  abortChildren: () => void,
  operation: Promise<T>
): Promise<T> {
  if (!signal) {
    return operation
  }
  let abortReject: ((error: Error) => void) | null = null
  let suppressLateOperationError = false
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortReject = reject
  })
  const abort = (): void => {
    // Abort connection teardown without waiting indefinitely for signalled ssh/tar children.
    abortChildren()
    suppressLateOperationError = true
    abortReject?.(
      Object.assign(createAbortError(), {
        // No exit proof on fast abort; callers must retain remote locks.
        sshChannelCloseConfirmed: false
      })
    )
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) {
    abort()
  }
  try {
    return await Promise.race([
      operation.catch((error: unknown) => {
        if (suppressLateOperationError) {
          return new Promise<never>(() => {})
        }
        throw error
      }),
      abortPromise
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return
  }
  throw createAbortError()
}

function createAbortError(): Error & { name: string } {
  const error = new Error('System SSH operation was cancelled') as Error & { name: string }
  error.name = 'AbortError'
  return error
}
