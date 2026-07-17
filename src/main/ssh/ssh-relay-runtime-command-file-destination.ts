import type { SshRelayRuntimeSourceDestination } from './ssh-relay-runtime-source-stream'

type ChannelWriteCallback = (error?: Error) => void

export type SshRelayRuntimeCommandFileChannel = Readonly<{
  write: (chunk: Buffer, callback: ChannelWriteCallback) => void
  end: () => void
  settled: Promise<void>
  requestClose: () => void
  forceClose: () => void
}>

export type OpenSshRelayRuntimeCommandFileDestinationOptions = Readonly<{
  command: string
  fileKind: 'POSIX' | 'Windows'
  signal: AbortSignal
  openChannel: (command: string, signal: AbortSignal) => Promise<SshRelayRuntimeCommandFileChannel>
}>

export const SSH_RELAY_RUNTIME_COMMAND_FILE_DESTINATION_LIMITS = Object.freeze({
  gracefulCloseMs: 250,
  totalCloseMs: 2_000
})

type DestinationState = 'open' | 'closing' | 'complete' | 'aborting' | 'aborted'
type ChannelSettlement = Readonly<{ ok: true } | { ok: false; error: unknown }>
type AbortOutcome = Readonly<{ reason: unknown }>

function validateOptions(options: OpenSshRelayRuntimeCommandFileDestinationOptions): void {
  if (
    !options ||
    typeof options.command !== 'string' ||
    options.command === '' ||
    (options.fileKind !== 'POSIX' && options.fileKind !== 'Windows') ||
    typeof options.openChannel !== 'function' ||
    !options.signal
  ) {
    throw new Error('SSH relay runtime command file destination input is invalid')
  }
}

function validateChannel(
  channel: SshRelayRuntimeCommandFileChannel,
  fileKind: 'POSIX' | 'Windows'
): void {
  if (
    !channel ||
    typeof channel.write !== 'function' ||
    typeof channel.end !== 'function' ||
    typeof channel.settled?.then !== 'function' ||
    typeof channel.requestClose !== 'function' ||
    typeof channel.forceClose !== 'function'
  ) {
    throw new Error(`SSH relay runtime ${fileKind} file channel is invalid`)
  }
}

function cleanupFailure(
  failures: readonly unknown[],
  fileKind: 'POSIX' | 'Windows'
): unknown | undefined {
  if (failures.length === 0) {
    return undefined
  }
  return failures.length === 1
    ? failures[0]
    : new AggregateError(failures, `SSH relay runtime ${fileKind} file channel cleanup failed`)
}

function waitForSettlement(
  settlement: Promise<ChannelSettlement>,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs)
    void settlement.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

async function settleCancelledChannel(
  channel: SshRelayRuntimeCommandFileChannel,
  settlement: Promise<ChannelSettlement>,
  fileKind: 'POSIX' | 'Windows'
): Promise<void> {
  const failures: unknown[] = []
  try {
    channel.requestClose()
  } catch (error) {
    failures.push(error)
  }

  const graceful = await waitForSettlement(
    settlement,
    SSH_RELAY_RUNTIME_COMMAND_FILE_DESTINATION_LIMITS.gracefulCloseMs
  )
  if (!graceful) {
    try {
      channel.forceClose()
    } catch (error) {
      failures.push(error)
    }
    const forced = await waitForSettlement(
      settlement,
      SSH_RELAY_RUNTIME_COMMAND_FILE_DESTINATION_LIMITS.totalCloseMs -
        SSH_RELAY_RUNTIME_COMMAND_FILE_DESTINATION_LIMITS.gracefulCloseMs
    )
    if (!forced) {
      failures.unshift(new Error(`SSH relay runtime ${fileKind} file channel settlement timed out`))
    }
  }

  const failure = cleanupFailure(failures, fileKind)
  if (failure !== undefined) {
    throw failure
  }
}

function createDestination(
  signal: AbortSignal,
  channel: SshRelayRuntimeCommandFileChannel,
  fileKind: 'POSIX' | 'Windows'
): SshRelayRuntimeSourceDestination {
  const channelSettlement: Promise<ChannelSettlement> = channel.settled.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error })
  )
  let state: DestinationState = 'open'
  let activeOperation: Promise<void> | undefined
  let abortPromise: Promise<void> | undefined
  let abortReason: unknown
  let resolveAbortOutcome: (outcome: AbortOutcome) => void = () => {}
  const abortOutcome = new Promise<AbortOutcome>((resolve) => {
    resolveAbortOutcome = resolve
  })

  const assertWritable = (): void => {
    if (state !== 'open') {
      throw new Error(`SSH relay runtime ${fileKind} file destination is closed`)
    }
    if (activeOperation) {
      throw new Error(`SSH relay runtime ${fileKind} file destination has a concurrent operation`)
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
  const waitForOperation = async (operation: Promise<void>): Promise<void> => {
    const result = await Promise.race([
      operation.then(
        () => ({ kind: 'complete' as const }),
        (error: unknown) => ({ kind: 'failed' as const, error })
      ),
      abortOutcome.then((outcome) => ({ kind: 'aborted' as const, outcome }))
    ])
    if (result.kind === 'aborted') {
      throw result.outcome.reason
    }
    if (state === 'aborting' || state === 'aborted') {
      throw (await abortOutcome).reason
    }
    if (result.kind === 'failed') {
      throw result.error
    }
  }

  const performAbort = async (): Promise<void> => {
    const reason = abortReason
    let failure: unknown
    try {
      await settleCancelledChannel(channel, channelSettlement, fileKind)
    } catch (error) {
      failure = error
    } finally {
      state = 'aborted'
      signal.removeEventListener('abort', onSignalAbort)
      // Why: retained transport buffers are released only after the channel settles or times out.
      resolveAbortOutcome({ reason })
    }
    if (failure !== undefined) {
      throw failure
    }
  }
  const abort = (reason: unknown): Promise<void> => {
    if (abortPromise) {
      return abortPromise
    }
    if (state === 'complete' || state === 'aborted') {
      abortPromise = Promise.resolve()
      return abortPromise
    }
    state = 'aborting'
    abortReason = reason
    abortPromise = performAbort()
    return abortPromise
  }
  function onSignalAbort(): void {
    void abort(signal.reason).catch(() => {})
  }

  const write = (chunk: Buffer): Promise<void> => {
    try {
      assertWritable()
    } catch (error) {
      return Promise.reject(error)
    }
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
      return Promise.reject(
        new Error(`SSH relay runtime ${fileKind} file destination chunk is empty`)
      )
    }
    return runExclusive(async () => {
      signal.throwIfAborted()
      // Why: the callback is the byte-retention boundary before a source worker reuses its buffer.
      const accepted = new Promise<void>((resolve, reject) => {
        channel.write(chunk, (error) => (error ? reject(error) : resolve()))
      })
      await waitForOperation(accepted)
      signal.throwIfAborted()
    })
  }
  const close = (): Promise<void> => {
    try {
      assertWritable()
    } catch (error) {
      return Promise.reject(error)
    }
    state = 'closing'
    return runExclusive(async () => {
      signal.throwIfAborted()
      channel.end()
      const settled = await Promise.race([
        channelSettlement,
        abortOutcome.then((outcome) => ({ ok: false as const, error: outcome.reason }))
      ])
      if (state === 'aborting' || state === 'aborted') {
        throw (await abortOutcome).reason
      }
      if (!settled.ok) {
        throw settled.error
      }
      signal.throwIfAborted()
      state = 'complete'
      signal.removeEventListener('abort', onSignalAbort)
    })
  }

  signal.addEventListener('abort', onSignalAbort, { once: true })
  if (signal.aborted) {
    onSignalAbort()
  }
  return Object.freeze({ write, close, abort })
}

export async function openSshRelayRuntimeCommandFileDestination(
  options: OpenSshRelayRuntimeCommandFileDestinationOptions
): Promise<SshRelayRuntimeSourceDestination> {
  validateOptions(options)
  options.signal.throwIfAborted()
  const channel = await options.openChannel(options.command, options.signal)
  validateChannel(channel, options.fileKind)
  const destination = createDestination(options.signal, channel, options.fileKind)
  try {
    options.signal.throwIfAborted()
    return destination
  } catch (error) {
    try {
      await destination.abort(error)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `SSH relay runtime ${options.fileKind} file open cancellation cleanup failed`
      )
    }
    throw error
  }
}
