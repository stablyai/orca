import type { Readable } from 'node:stream'
import type {
  RemoteCommandChannel,
  RemoteInstallTransport
} from '../../managed-server/install/remote-install-transport'
import { createSshOperationAbortError, type SshExecOptions } from '../connection/ssh-exec-options'
import {
  REMOTE_COMMAND_DECODER_UNAVAILABLE,
  REMOTE_COMMAND_DECODER_UNAVAILABLE_EXIT
} from '../ssh-posix-command-wrapper'
import {
  redactRelayInstallMarkerError,
  redactRelayInstallMarkerTokens
} from '../../managed-server/install/remote-install-marker'
import type { SystemSshCommandChannel } from '../system-transport/system-ssh-command'
import { buildPosixStdoutFence } from '../../../shared/posix-stdout-fence'

const EXEC_TIMEOUT_MS = 30_000
const COMMAND_CLOSE_GRACE_MS = 5_000
const MAX_EXEC_OUTPUT_CHARS = 1024 * 1024

type ExecCommandOptions = SshExecOptions & {
  timeoutMs?: number
  // Why: a zero-exit command resolves with stdout alone, so the reason a wrapped-in-`|| echo`
  // probe failed is discarded. Callers that need that diagnostic opt in here rather than
  // folding stderr into stdout, where it would match the probe's own token strings.
  // On the system-ssh transport this stream also carries local OpenSSH noise; log-only.
  onStderr?: (stderr: string) => void
  /** Streamed into the command's stdin, then EOF. A read error terminates the command. */
  stdin?: Readable
}

type SshCommandTerminationError = Error & {
  sshChannelCloseConfirmed: boolean
}

// Why: callers must tell "the host answered no" from "the host never answered". Matching the
// message text is what let an unanswered probe be read as a definitive negative.
export const SSH_EXEC_TIMEOUT_CODE = 'SSH_EXEC_TIMEOUT'

export function isSshExecTimeout(error: unknown): boolean {
  return (
    error instanceof Error && (error as Partial<{ code: string }>).code === SSH_EXEC_TIMEOUT_CODE
  )
}

export function isUnconfirmedSshCommandTermination(
  error: unknown
): error is SshCommandTerminationError {
  return (
    error instanceof Error &&
    (error as Partial<SshCommandTerminationError>).sshChannelCloseConfirmed === false
  )
}

/** A command that ran and exited nonzero; `stdout` is its own output, never the command text. */
export type SshCommandExitError = Error & { exitCode: number; stdout: string }

export function isSshCommandExitError(error: unknown): error is SshCommandExitError {
  return (
    error instanceof Error &&
    'exitCode' in error &&
    typeof error.exitCode === 'number' &&
    'stdout' in error &&
    typeof error.stdout === 'string'
  )
}

export function sshCommandExitError(
  command: string,
  code: number,
  stdout: string,
  output = stdout.trim()
): SshCommandExitError {
  const message = `Command "${redactRelayInstallMarkerTokens(command)}" failed (exit ${code}): ${redactRelayInstallMarkerTokens(output)}`
  return Object.assign(new Error(message), {
    exitCode: code,
    stdout: redactRelayInstallMarkerTokens(stdout)
  })
}

type ExecTransport = Pick<
  RemoteInstallTransport,
  'exec' | 'execWithClosedStdin' | 'usesSystemSshTransport'
>

// Hosts that could not decode a compressed command; they get every command plain. Keyed by SSH
// target id where the transport has one, so a reconnect's new connection object keeps the verdict.
const targetsWithoutCommandDecoder = new Set<string>()
const transportsWithoutCommandDecoder = new WeakSet<ExecTransport>()

function commandDecoderTargetId(conn: ExecTransport): string | null {
  if (!('getTarget' in conn) || typeof conn.getTarget !== 'function') {
    return null
  }
  const target: unknown = conn.getTarget()
  return typeof target === 'object' &&
    target !== null &&
    'id' in target &&
    typeof target.id === 'string'
    ? target.id
    : null
}

function lacksCommandDecoder(conn: ExecTransport): boolean {
  const id = commandDecoderTargetId(conn)
  return id === null
    ? transportsWithoutCommandDecoder.has(conn)
    : targetsWithoutCommandDecoder.has(id)
}

function rememberLacksCommandDecoder(conn: ExecTransport): void {
  const id = commandDecoderTargetId(conn)
  if (id === null) {
    transportsWithoutCommandDecoder.add(conn)
  } else {
    targetsWithoutCommandDecoder.add(id)
  }
}

function isCommandDecoderUnavailable(error: unknown): boolean {
  return (
    isSshCommandExitError(error) &&
    error.exitCode === REMOTE_COMMAND_DECODER_UNAVAILABLE_EXIT &&
    error.message.includes(REMOTE_COMMAND_DECODER_UNAVAILABLE)
  )
}

export async function execCommand(
  conn: ExecTransport,
  command: string,
  options?: ExecCommandOptions
): Promise<string> {
  if (lacksCommandDecoder(conn)) {
    return execCommandOnce(conn, command, { ...options, compressCommand: false })
  }
  try {
    return await execCommandOnce(conn, command, {
      ...options,
      // Not with stdin: its bytes are spent once, so a decoder miss could not be resent.
      compressCommand: options?.compressCommand ?? !options?.stdin
    })
  } catch (error) {
    // Nothing ran: the wrapper checks for its decoders before reading stdin or the script.
    if (
      options?.stdin ||
      options?.compressCommand === false ||
      !isCommandDecoderUnavailable(error)
    ) {
      throw error
    }
    rememberLacksCommandDecoder(conn)
    return execCommandOnce(conn, command, { ...options, compressCommand: false })
  }
}

async function execCommandOnce(
  conn: ExecTransport,
  command: string,
  options?: ExecCommandOptions
): Promise<string> {
  const { timeoutMs = EXEC_TIMEOUT_MS, onStderr, stdin, ...execOptions } = options ?? {}
  const signal = options?.signal
  if (signal?.aborted) {
    throw createSshOperationAbortError()
  }
  // Why: reconnect/disconnect can flip the connection back to ssh2 before a
  // killed local OpenSSH child emits close; the channel's transport is immutable.
  const openedWithSystemSsh = conn.usesSystemSshTransport?.() === true
  // Why: sshd runs the user's login shell before our /bin/sh wrapper, so rc-file stdout
  // (an `echo`, a title escape) would otherwise be read as the command's answer.
  const fence = execOptions.wrapCommand === false ? null : buildPosixStdoutFence(command, 'SSH')
  const readPayload = (stdout: string): string => fence?.readStdout(stdout) ?? stdout
  let channel: RemoteCommandChannel
  try {
    // Why only without `stdin`: nothing below writes or ends the channel's stdin otherwise.
    channel =
      !stdin && conn.execWithClosedStdin
        ? await conn.execWithClosedStdin(fence?.command ?? command, execOptions)
        : await conn.exec(fence?.command ?? command, execOptions)
  } catch (error) {
    // Preserve identity/classifier fields while removing install-owner tokens.
    redactRelayInstallMarkerError(error)
    throw error
  }
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let terminationError: SshCommandTerminationError | null = null
    let closeGraceTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      clearTimeout(timeout)
      if (closeGraceTimer) {
        clearTimeout(closeGraceTimer)
      }
      signal?.removeEventListener('abort', onAbort)
      channel.off('error', fail)
      channel.stderr.off('error', fail)
      channel.off('data', onStdoutData)
      channel.stderr.off('data', onStderrData)
      channel.off('close', onClose)
      if (stdin) {
        stdin.off('error', fail)
        stdin.unpipe(channel.stdin)
        stdin.destroy()
      }
    }
    const settle = (fn: typeof resolve | typeof reject, val: string | Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      fn(val as never)
    }
    const guardUnconfirmedTeardown = (): void => {
      const swallowLateError = (): void => {}
      const cleanupGuards = (): void => {
        channel.off('error', swallowLateError)
        channel.stderr.off('error', swallowLateError)
        channel.off('close', cleanupGuards)
      }
      channel.on('error', swallowLateError)
      channel.stderr.on('error', swallowLateError)
      channel.once('close', cleanupGuards)
      // Why: an unconfirmed close can arrive after the caller's bounded wait;
      // keep draining discarded streams so ssh2 can finish CHANNEL_CLOSE.
      channel.resume()
      channel.stderr.resume()
    }
    // Why: sshd counts the session against MaxSessions until CHANNEL_CLOSE
    // completes. Settling on abort before the channel actually closes lets the
    // concurrent-bootstrap sequential fallback reissue an exec while the slot
    // is still held, so it gets refused again. Close and settle from onClose.
    const requestTermination = (error: Error): void => {
      if (terminationError) {
        return
      }
      terminationError = Object.assign(error, { sshChannelCloseConfirmed: false })
      clearTimeout(timeout)
      // Why: callers must not release an install lock while its remote npm
      // process can still mutate node_modules. Prefer confirmed channel close,
      // but bound a broken transport's teardown wait.
      closeGraceTimer = setTimeout(() => {
        guardUnconfirmedTeardown()
        settle(reject, error)
      }, COMMAND_CLOSE_GRACE_MS)
      channel.close()
    }
    const fail = (err: Error): void => {
      redactRelayInstallMarkerError(err)
      requestTermination(err)
    }
    const onAbort = (): void => requestTermination(createSshOperationAbortError())
    const onStdoutData = (data: Buffer): void => {
      stdout = appendExecOutputTail(stdout, data.toString('utf-8'))
    }
    const onStderrData = (data: Buffer): void => {
      stderr = appendExecOutputTail(stderr, data.toString('utf-8'))
    }
    const onClose = (code: number): void => {
      if (
        !terminationError &&
        openedWithSystemSsh &&
        (channel as SystemSshCommandChannel)._closeRequested
      ) {
        terminationError = Object.assign(createSshOperationAbortError(), {
          sshChannelCloseConfirmed: false
        })
      }
      if (terminationError) {
        // Why: a system-SSH channel closes when the local OpenSSH child exits;
        // that does not prove the remote command stopped, especially with a ControlMaster.
        if (!openedWithSystemSsh) {
          terminationError.sshChannelCloseConfirmed = true
        }
        settle(reject, terminationError)
      } else if (code !== 0) {
        // Why: on the system-ssh transport channel.stderr carries local OpenSSH
        // client noise; preferring it masks the real failure in stdout (2>&1).
        const payload = readPayload(stdout)
        const output = [stderr.trim(), payload.trim()].filter(Boolean).join('\n')
        settle(reject, sshCommandExitError(command, code, payload, output))
      } else {
        if (stderr && onStderr) {
          onStderr(redactRelayInstallMarkerTokens(stderr))
        }
        settle(resolve, readPayload(stdout))
      }
    }
    const timeout = setTimeout(() => {
      requestTermination(
        Object.assign(
          new Error(
            `Command "${redactRelayInstallMarkerTokens(command)}" timed out after ${
              timeoutMs / 1000
            }s`
          ),
          { code: SSH_EXEC_TIMEOUT_CODE }
        )
      )
    }, timeoutMs)

    // Why: remote reboot tears down exec channels with stream errors. Without
    // scoped listeners, Node treats those as uncaught exceptions.
    signal?.addEventListener('abort', onAbort, { once: true })
    channel.on('error', fail)
    channel.stderr.on('error', fail)
    channel.on('data', onStdoutData)
    channel.stderr.on('data', onStderrData)
    channel.on('close', onClose)
    if (stdin) {
      stdin.on('error', fail)
      // Why `.stdin`: ssh2 aliases it to the channel, and a system-ssh channel only ends it there.
      stdin.pipe(channel.stdin)
    }
    if (signal?.aborted) {
      onAbort()
    }
  })
}

function appendExecOutputTail(existing: string, chunk: string): string {
  const combined = existing + chunk
  return combined.length > MAX_EXEC_OUTPUT_CHARS ? combined.slice(-MAX_EXEC_OUTPUT_CHARS) : combined
}
