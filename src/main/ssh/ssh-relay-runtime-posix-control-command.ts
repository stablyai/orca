import type { SshRelayRuntimePosixFileChannel } from './ssh-relay-runtime-posix-file-destination'

export type RunSshRelayRuntimePosixControlCommandOptions = Readonly<{
  command: string
  signal: AbortSignal
  openChannel: (command: string, signal: AbortSignal) => Promise<SshRelayRuntimePosixFileChannel>
}>

const COMMAND_TIMEOUT_MS = 30_000
const GRACEFUL_CLOSE_MS = 250
const TOTAL_CLOSE_MS = 2_000

type ChannelSettlement = Readonly<{ ok: true } | { ok: false; error: unknown }>

function validateOptions(options: RunSshRelayRuntimePosixControlCommandOptions): void {
  if (
    !options ||
    typeof options.command !== 'string' ||
    options.command === '' ||
    options.command.includes('\0') ||
    options.command.includes('\r') ||
    options.command.includes('\n') ||
    !options.signal ||
    typeof options.openChannel !== 'function'
  ) {
    throw new Error('SSH relay runtime POSIX control command input is invalid')
  }
}

function validateChannel(channel: SshRelayRuntimePosixFileChannel): void {
  if (
    !channel ||
    typeof channel.end !== 'function' ||
    typeof channel.settled?.then !== 'function' ||
    typeof channel.requestClose !== 'function' ||
    typeof channel.forceClose !== 'function'
  ) {
    throw new Error('SSH relay runtime POSIX control command channel is invalid')
  }
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

async function terminateChannel(
  channel: SshRelayRuntimePosixFileChannel,
  settlement: Promise<ChannelSettlement>
): Promise<unknown[]> {
  const failures: unknown[] = []
  try {
    channel.requestClose()
  } catch (error) {
    failures.push(error)
  }
  const graceful = await waitForSettlement(settlement, GRACEFUL_CLOSE_MS)
  if (graceful) {
    return failures
  }
  try {
    channel.forceClose()
  } catch (error) {
    failures.push(error)
  }
  const forced = await waitForSettlement(settlement, TOTAL_CLOSE_MS - GRACEFUL_CLOSE_MS)
  if (!forced) {
    failures.push(new Error('SSH relay runtime POSIX control command settlement timed out'))
  }
  return failures
}

function joinedFailure(primary: unknown, cleanupFailures: readonly unknown[]): unknown {
  if (cleanupFailures.length === 0) {
    return primary
  }
  return new AggregateError(
    [primary, ...cleanupFailures],
    'SSH relay runtime POSIX control command termination failed'
  )
}

export async function runSshRelayRuntimePosixControlCommand(
  options: RunSshRelayRuntimePosixControlCommandOptions
): Promise<void> {
  validateOptions(options)
  const { command, signal, openChannel } = options
  signal.throwIfAborted()
  const channel = await openChannel(command, signal)
  validateChannel(channel)
  const settlement: Promise<ChannelSettlement> = channel.settled.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error })
  )
  let interrupted = false
  let interruptionReason: unknown
  let resolveInterruption: (() => void) | undefined
  const interruption = new Promise<void>((resolve) => {
    resolveInterruption = resolve
  })
  let termination = Promise.resolve<unknown[]>([])
  const interrupt = (reason: unknown): void => {
    if (interrupted) {
      return
    }
    interrupted = true
    interruptionReason = reason
    // Why: callers may reuse a session slot only after the local OpenSSH child has settled.
    termination = terminateChannel(channel, settlement)
    resolveInterruption?.()
  }
  const onAbort = (): void => interrupt(signal.reason)
  const commandTimeout = setTimeout(
    () => interrupt(new Error('SSH relay runtime POSIX control command timed out')),
    COMMAND_TIMEOUT_MS
  )
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) {
    onAbort()
  }

  try {
    if (!interrupted) {
      try {
        channel.end()
      } catch (error) {
        interrupt(error)
      }
    }
    const outcome = await Promise.race([
      settlement.then((value) => ({ kind: 'settled' as const, value })),
      interruption.then(() => ({ kind: 'interrupted' as const }))
    ])
    if (outcome.kind === 'interrupted') {
      const cleanupFailures = await termination
      throw joinedFailure(interruptionReason, cleanupFailures)
    }
    if (!outcome.value.ok) {
      throw outcome.value.error
    }
  } finally {
    clearTimeout(commandTimeout)
    signal.removeEventListener('abort', onAbort)
  }
}

export const SSH_RELAY_RUNTIME_POSIX_CONTROL_COMMAND_LIMITS = Object.freeze({
  commandTimeoutMs: COMMAND_TIMEOUT_MS,
  gracefulCloseMs: GRACEFUL_CLOSE_MS,
  totalCloseMs: TOTAL_CLOSE_MS
})
