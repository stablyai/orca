import type { SFTPWrapper } from 'ssh2'

import type {
  SshRelayRuntimeSftpTreeOperations,
  SshRelayRuntimeSftpTreeSession
} from './ssh-relay-runtime-sftp-tree-transfer'

const SESSION_CLOSE_GRACE_MS = 5_000

export type OpenSshRelayRuntimeSftpTreeSessionOptions = Readonly<{
  signal: AbortSignal
  openRawSession: (signal: AbortSignal) => Promise<SFTPWrapper>
  // Why: a peer that ignores channel close must not retain source buffers indefinitely.
  forceCloseConnection: (reason: unknown) => Promise<void>
}>

type SessionState = 'open' | 'closing' | 'closed'

function closedOperationError(): Error {
  return new Error('SSH relay runtime SFTP session is closing or closed')
}

function uniqueFailures(failures: readonly unknown[]): unknown[] {
  return failures.filter((failure, index) => failures.indexOf(failure) === index)
}

function cleanupFailure(failures: readonly unknown[]): unknown | undefined {
  const unique = uniqueFailures(failures)
  if (unique.length === 0) {
    return undefined
  }
  return unique.length === 1
    ? unique[0]
    : new AggregateError(unique, 'SSH relay runtime SFTP session close failed')
}

function createBoundOperations(
  raw: SFTPWrapper,
  getState: () => SessionState
): SshRelayRuntimeSftpTreeOperations {
  const isClosed = (): boolean => getState() !== 'open'
  return Object.freeze({
    mkdir: (path, attributes, callback) => {
      if (isClosed()) {
        callback(closedOperationError())
        return
      }
      raw.mkdir(path, attributes, (error) => callback(error ?? undefined))
    },
    rmdir: (path, callback) => {
      if (isClosed()) {
        callback(closedOperationError())
        return
      }
      raw.rmdir(path, (error) => callback(error ?? undefined))
    },
    open: (path, flags, attributes, callback) => {
      if (isClosed()) {
        callback(closedOperationError(), Buffer.alloc(0))
        return
      }
      raw.open(path, flags, attributes, (error, handle) => callback(error ?? undefined, handle))
    },
    write: (handle, buffer, offset, length, position, callback) => {
      if (isClosed()) {
        callback(closedOperationError())
        return
      }
      // Why: only the raw callback releases the source stream's borrowed chunk view.
      raw.write(handle, buffer, offset, length, position, (error) => callback(error ?? undefined))
    },
    fchmod: (handle, mode, callback) => {
      if (isClosed()) {
        callback(closedOperationError())
        return
      }
      raw.fchmod(handle, mode, (error) => callback(error ?? undefined))
    },
    fstat: (handle, callback) => {
      if (isClosed()) {
        callback(closedOperationError(), { mode: 0 } as never)
        return
      }
      raw.fstat(handle, (error, attributes) => callback(error ?? undefined, attributes))
    },
    close: (handle, callback) => {
      if (isClosed()) {
        callback(closedOperationError())
        return
      }
      raw.close(handle, (error) => callback(error ?? undefined))
    },
    unlink: (path, callback) => {
      if (isClosed()) {
        callback(closedOperationError())
        return
      }
      raw.unlink(path, (error) => callback(error ?? undefined))
    }
  })
}

function createSession(
  raw: SFTPWrapper,
  forceCloseConnection: (reason: unknown) => Promise<void>
): SshRelayRuntimeSftpTreeSession {
  let state: SessionState = 'open'
  let rawError: unknown
  let closePromise: Promise<void> | undefined
  let resolveRawClose: (() => void) | undefined
  const rawClose = new Promise<void>((resolve) => {
    resolveRawClose = resolve
  })
  const onRawClose = (): void => resolveRawClose?.()
  const onRawError = (error: unknown): void => {
    rawError ??= error
  }
  const swallowLateRawError = (): void => {}
  raw.once('close', onRawClose)
  raw.on('error', onRawError)

  const finishListeners = (): void => {
    raw.removeListener('error', onRawError)
    // Why: ssh2 can emit a final socket error after channel close; no owner remains to observe it.
    raw.on('error', swallowLateRawError)
  }

  const waitForCloseGrace = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const grace = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), SESSION_CLOSE_GRACE_MS)
    })
    const closed = await Promise.race([rawClose.then(() => true as const), grace])
    clearTimeout(timer)
    return closed
  }

  const performClose = async (reason?: unknown): Promise<void> => {
    state = 'closing'
    const failures: unknown[] = []
    let ended = false
    try {
      raw.end()
      ended = true
    } catch (error) {
      failures.push(error)
    }

    if (!ended || !(await waitForCloseGrace())) {
      const forceReason = reason ?? failures[0] ?? rawError ?? closedOperationError()
      try {
        await forceCloseConnection(forceReason)
      } catch (error) {
        failures.push(error)
        state = 'closed'
        finishListeners()
        throw cleanupFailure(failures)
      }
      // Why: force-close completion alone is insufficient; raw close proves request callbacks ran.
      await rawClose
    }
    state = 'closed'
    finishListeners()
    if (rawError !== undefined) {
      failures.push(rawError)
    }
    const failure = cleanupFailure(failures)
    if (failure !== undefined) {
      throw failure
    }
  }

  const close = (reason?: unknown): Promise<void> => {
    closePromise ??= performClose(reason)
    return closePromise
  }
  const operations = createBoundOperations(raw, () => state)
  return Object.freeze({ operations, close })
}

export async function openSshRelayRuntimeSftpTreeSession(
  options: OpenSshRelayRuntimeSftpTreeSessionOptions
): Promise<SshRelayRuntimeSftpTreeSession> {
  if (
    !options ||
    typeof options.openRawSession !== 'function' ||
    typeof options.forceCloseConnection !== 'function'
  ) {
    throw new Error('SSH relay runtime SFTP session adapter input is invalid')
  }
  options.signal.throwIfAborted()
  const raw = await options.openRawSession(options.signal)
  const session = createSession(raw, options.forceCloseConnection)
  try {
    options.signal.throwIfAborted()
    return session
  } catch (error) {
    try {
      await session.close(error)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'SSH relay runtime SFTP session open cancellation cleanup failed'
      )
    }
    throw error
  }
}
