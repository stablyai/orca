import type { ChildProcess } from 'node:child_process'
import type { SystemSshCommandChannel } from './system-ssh-command'

export type ProcessResult = { label: string; stderr: string }

export function waitForChannelClose(
  channel: SystemSshCommandChannel,
  label: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    const cleanup = (): void => {
      channel.stderr.off('data', onStderrData)
      channel.off('error', onError)
      channel.off('close', onClose)
    }
    const settle = (fn: typeof resolve | typeof reject, val?: unknown): void => {
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
        const detail = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`
        settle(reject, new Error(`${label} failed (${detail}): ${stderr.trim()}`))
        return
      }
      settle(resolve)
    }

    channel.stderr.on('data', onStderrData)
    channel.on('error', onError)
    channel.on('close', onClose)
  })
}

export function waitForProcess(proc: ChildProcess, label: string): Promise<ProcessResult> {
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
    const onClose = (code: number | null): void => {
      if (code !== 0) {
        settle(reject, new Error(`${label} failed (exit ${code}): ${stderr.trim()}`))
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
    // Why: abort is connection teardown; do not wait for stubborn system ssh/tar
    // children to emit close after we've already signaled them.
    abortChildren()
    suppressLateOperationError = true
    abortReject?.(
      Object.assign(createAbortError(), {
        // The child was signaled, but this fast abort path intentionally does
        // not wait for process exit; callers holding remote locks must retain them.
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
