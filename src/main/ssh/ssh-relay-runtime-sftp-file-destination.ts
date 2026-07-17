import type { SshRelayRuntimeSourceDestination } from './ssh-relay-runtime-source-stream'

type SftpCallback = (error?: Error) => void

export type SshRelayRuntimeSftpFileOperations = Readonly<{
  open: (
    path: string,
    flags: 'wx',
    attributes: { mode: number },
    callback: (error: Error | undefined, handle: Buffer) => void
  ) => void
  write: (
    handle: Buffer,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: SftpCallback
  ) => void
  fchmod: (handle: Buffer, mode: number, callback: SftpCallback) => void
  fstat: (
    handle: Buffer,
    callback: (error: Error | undefined, attributes: { mode: number }) => void
  ) => void
  close: (handle: Buffer, callback: SftpCallback) => void
  unlink: (path: string, callback: SftpCallback) => void
}>

export type OpenSshRelayRuntimeSftpFileDestinationOptions = Readonly<{
  operations: SshRelayRuntimeSftpFileOperations
  remotePath: string
  mode: 0o644 | 0o755
  enforcePosixMode: boolean
  signal: AbortSignal
}>

type DestinationState = 'open' | 'closed' | 'complete' | 'aborting' | 'aborted'

function waitForSftpCallback(register: (callback: SftpCallback) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    register((error) => (error ? reject(error) : resolve()))
  })
}

function waitForSftpValue<T>(
  register: (callback: (error: Error | undefined, value: T) => void) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    register((error, value) => (error ? reject(error) : resolve(value)))
  })
}

function cleanupFailure(failures: readonly unknown[]): unknown | undefined {
  if (failures.length === 0) {
    return undefined
  }
  return failures.length === 1
    ? failures[0]
    : new AggregateError(failures, 'SSH relay runtime SFTP file cleanup failed')
}

function validateOptions(options: OpenSshRelayRuntimeSftpFileDestinationOptions): void {
  if (!options.operations || typeof options.remotePath !== 'string' || options.remotePath === '') {
    throw new Error('SSH relay runtime SFTP file destination input is invalid')
  }
  if (options.remotePath.includes('\0')) {
    throw new Error('SSH relay runtime SFTP file destination path is invalid')
  }
  if (options.mode !== 0o644 && options.mode !== 0o755) {
    throw new Error('SSH relay runtime SFTP file destination mode is invalid')
  }
}

function createDestination(
  options: OpenSshRelayRuntimeSftpFileDestinationOptions,
  handle: Buffer
): SshRelayRuntimeSourceDestination {
  const { operations, remotePath, mode, enforcePosixMode, signal } = options
  let state: DestinationState = 'open'
  let position = 0
  let activeOperation: Promise<void> | undefined
  let abortPromise: Promise<void> | undefined

  const assertWritable = (): void => {
    if (state !== 'open') {
      throw new Error('SSH relay runtime SFTP file destination is closed')
    }
    if (activeOperation) {
      throw new Error('SSH relay runtime SFTP file destination has a concurrent operation')
    }
  }

  const runExclusive = (operation: () => Promise<void>): Promise<void> => {
    const pending = operation()
    activeOperation = pending
    void pending
      .finally(() => {
        if (activeOperation === pending) {
          activeOperation = undefined
        }
      })
      .catch(() => {})
    return pending
  }

  const write = (chunk: Buffer): Promise<void> => {
    try {
      assertWritable()
    } catch (error) {
      return Promise.reject(error)
    }
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      return Promise.reject(new Error('SSH relay runtime SFTP file destination chunk is empty'))
    }
    return runExclusive(async () => {
      signal.throwIfAborted()
      // Why: the callback is the remote-consumption boundary; resolving earlier could let the
      // source worker reuse its one buffer while ssh2 still retains the chunk view.
      await waitForSftpCallback((callback) =>
        operations.write(handle, chunk, 0, chunk.length, position, callback)
      )
      position += chunk.length
      signal.throwIfAborted()
    })
  }

  const close = (): Promise<void> => {
    try {
      assertWritable()
    } catch (error) {
      return Promise.reject(error)
    }
    return runExclusive(async () => {
      signal.throwIfAborted()
      if (enforcePosixMode) {
        await waitForSftpCallback((callback) => operations.fchmod(handle, mode, callback))
        signal.throwIfAborted()
        const attributes = await waitForSftpValue<{ mode: number }>((callback) =>
          operations.fstat(handle, callback)
        )
        if (!Number.isInteger(attributes.mode) || (attributes.mode & 0o777) !== mode) {
          throw new Error('SSH relay runtime SFTP file mode verification failed')
        }
      }
      signal.throwIfAborted()
      await waitForSftpCallback((callback) => operations.close(handle, callback))
      state = 'closed'
      signal.throwIfAborted()
      state = 'complete'
    })
  }

  const performAbort = async (): Promise<void> => {
    if (state === 'complete' || state === 'aborted') {
      return
    }
    const pending = activeOperation
    if (pending) {
      await pending.catch(() => {})
    }
    const handleNeedsClose = state !== 'closed'
    state = 'aborting'
    const failures: unknown[] = []
    if (handleNeedsClose) {
      await waitForSftpCallback((callback) => operations.close(handle, callback)).catch((error) =>
        failures.push(error)
      )
    }
    await waitForSftpCallback((callback) => operations.unlink(remotePath, callback)).catch(
      (error) => failures.push(error)
    )
    state = 'aborted'
    const failure = cleanupFailure(failures)
    if (failure !== undefined) {
      throw failure
    }
  }

  const abort = (_reason: unknown): Promise<void> => {
    abortPromise ??= performAbort()
    return abortPromise
  }

  return Object.freeze({ write, close, abort })
}

export async function openSshRelayRuntimeSftpFileDestination(
  options: OpenSshRelayRuntimeSftpFileDestinationOptions
): Promise<SshRelayRuntimeSourceDestination> {
  validateOptions(options)
  options.signal.throwIfAborted()
  const handle = await waitForSftpValue<Buffer>((callback) =>
    options.operations.open(options.remotePath, 'wx', { mode: options.mode }, callback)
  )
  const destination = createDestination(options, handle)
  try {
    options.signal.throwIfAborted()
    return destination
  } catch (error) {
    try {
      await destination.abort(error)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'SSH relay runtime SFTP file open cancellation cleanup failed'
      )
    }
    throw error
  }
}
