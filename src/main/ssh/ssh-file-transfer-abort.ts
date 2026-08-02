import { createSshOperationAbortError } from './ssh-connection-utils'

export function createLinkedSshFileTransferSignal(signals: readonly AbortSignal[]): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const listeners = signals.map((signal) => {
    const listener = (): void => controller.abort(signal.reason)
    if (signal.aborted) {
      listener()
    } else {
      signal.addEventListener('abort', listener, { once: true })
    }
    return { signal, listener }
  })
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener('abort', listener)
      }
    }
  }
}

export function raceSftpFileTransferWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  closeSftp: (onClose: () => void) => (() => void) | void
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    let operationSettled = false
    let sftpClosed = false
    let abortError:
      | (Error & {
          sshChannelCloseConfirmed: boolean
          sshTransferTeardownConfirmed: boolean
        })
      | null = null
    let closeGraceTimer: ReturnType<typeof setTimeout> | null = null
    let removeCloseListener: (() => void) | undefined
    const settle = (fn: typeof resolve | typeof reject, value: T | Error): void => {
      if (settled) {
        return
      }
      settled = true
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer)
      }
      signal.removeEventListener('abort', onAbort)
      removeCloseListener?.()
      removeCloseListener = undefined
      fn(value as never)
    }
    const onAbort = (): void => {
      // Why: rejecting the caller is insufficient; ending SFTP stops the
      // abandoned transfer from mutating a successor relay install.
      abortError = Object.assign(createSshOperationAbortError(), {
        sshChannelCloseConfirmed: false,
        sshTransferTeardownConfirmed: false
      })
      closeGraceTimer = setTimeout(() => settle(reject, abortError!), 5_000)
      const unregisterClose = closeSftp(() => {
        sftpClosed = true
        abortError!.sshChannelCloseConfirmed = true
        if (operationSettled) {
          abortError!.sshTransferTeardownConfirmed = true
          settle(reject, abortError!)
        }
      })
      removeCloseListener = typeof unregisterClose === 'function' ? unregisterClose : undefined
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        operationSettled = true
        if (!abortError) {
          settle(resolve, value)
        } else if (sftpClosed) {
          abortError.sshTransferTeardownConfirmed = true
          settle(reject, abortError)
        }
      },
      (error: unknown) => {
        operationSettled = true
        if (!abortError) {
          settle(reject, error instanceof Error ? error : new Error(String(error)))
        } else if (sftpClosed) {
          abortError.sshTransferTeardownConfirmed = true
          settle(reject, abortError)
        }
      }
    )
    if (signal.aborted) {
      onAbort()
    }
  })
}
