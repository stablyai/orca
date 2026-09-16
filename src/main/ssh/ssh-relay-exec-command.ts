import type { ClientChannel } from 'ssh2'
import type { SshConnection } from './ssh-connection'
import { createSshOperationAbortError, type SshExecOptions } from './ssh-connection-utils'
import {
  redactRelayInstallMarkerError,
  redactRelayInstallMarkerTokens
} from './ssh-relay-install-marker'
import type { SystemSshCommandChannel } from './system-ssh-command'

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

export async function execCommand(
  conn: SshConnection,
  command: string,
  options?: ExecCommandOptions
): Promise<string> {
  const { timeoutMs = EXEC_TIMEOUT_MS, onStderr, ...execOptions } = options ?? {}
  const signal = options?.signal
  if (signal?.aborted) {
    throw createSshOperationAbortError()
  }
  // Why: reconnect/disconnect can flip the connection back to ssh2 before a
  // killed local OpenSSH child emits close; the channel's transport is immutable.
  const openedWithSystemSsh = conn.usesSystemSshTransport?.() === true
  let channel: ClientChannel
  try {
    channel = await conn.exec(command, execOptions)
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
        const output = redactRelayInstallMarkerTokens(
          [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
        )
        settle(
          reject,
          new Error(
            `Command "${redactRelayInstallMarkerTokens(command)}" failed (exit ${code}): ${output}`
          )
        )
      } else {
        if (stderr && onStderr) {
          onStderr(redactRelayInstallMarkerTokens(stderr))
        }
        settle(resolve, stdout)
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
    if (signal?.aborted) {
      onAbort()
    }
  })
}

function appendExecOutputTail(existing: string, chunk: string): string {
  const combined = existing + chunk
  return combined.length > MAX_EXEC_OUTPUT_CHARS ? combined.slice(-MAX_EXEC_OUTPUT_CHARS) : combined
}
