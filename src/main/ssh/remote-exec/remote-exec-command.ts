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
  // Log stderr separately: zero-exit probes can need diagnostics, but mixing them into stdout could match probe tokens or OpenSSH noise.
  onStderr?: (stderr: string) => void
  /** Streamed into the command's stdin, then EOF. A read error terminates the command. */
  stdin?: Readable
}

type SshCommandTerminationError = Error & {
  sshChannelCloseConfirmed: boolean
}

// Use typed timeout identity so unanswered probes cannot be mistaken for host refusal.
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

/** stdout excludes quoted command text so classifiers see host output only. */
type SshCommandExitError = Error & { exitCode: number; stdout: string }

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

// Remember missing decoders across reconnect by target id; transports without ids use object identity.
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
      // stdin is single-use and cannot replay after a decoder miss.
      compressCommand: options?.compressCommand ?? !options?.stdin
    })
  } catch (error) {
    // Decoder checks precede script execution/input consumption, so plain retry has no side effects.
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
  // Capture transport at open: reconnect/disconnect may change the connection before this channel closes.
  const openedWithSystemSsh = conn.usesSystemSshTransport?.() === true
  // Fence login-shell startup stdout so banners/title escapes cannot become probe answers.
  const fence = execOptions.wrapCommand === false ? null : buildPosixStdoutFence(command, 'SSH')
  const readPayload = (stdout: string): string => fence?.readStdout(stdout) ?? stdout
  let channel: RemoteCommandChannel
  try {
    // Use closed stdin only when no input will be piped.
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
      // Drain discarded streams after bounded teardown so ssh2 can complete CHANNEL_CLOSE.
      channel.resume()
      channel.stderr.resume()
    }
    // Wait for CHANNEL_CLOSE before settling abort or sequential fallback can race sshd's held MaxSessions slot.
    const requestTermination = (error: Error): void => {
      if (terminationError) {
        return
      }
      terminationError = Object.assign(error, { sshChannelCloseConfirmed: false })
      clearTimeout(timeout)
      // Install locks must outlive possible remote mutations; prefer confirmed close but bound broken-transport teardown.
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
        // Local OpenSSH exit cannot prove remote command termination, especially through ControlMaster.
        if (!openedWithSystemSsh) {
          terminationError.sshChannelCloseConfirmed = true
        }
        settle(reject, terminationError)
      } else if (code !== 0) {
        // System SSH stderr is local client noise; prefer the remote command's merged stdout.
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

    // Handle stream errors from remote reboot instead of letting EventEmitter crash main.
    signal?.addEventListener('abort', onAbort, { once: true })
    channel.on('error', fail)
    channel.stderr.on('error', fail)
    channel.on('data', onStdoutData)
    channel.stderr.on('data', onStderrData)
    channel.on('close', onClose)
    if (stdin) {
      stdin.on('error', fail)
      // Pipe to .stdin: ssh2 aliases it to channel, while system SSH ends input only there.
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
