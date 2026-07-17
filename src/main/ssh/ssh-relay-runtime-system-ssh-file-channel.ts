import type { ClientChannel } from 'ssh2'
import type { SshRelayRuntimeCommandFileChannel } from './ssh-relay-runtime-command-file-destination'
import type { SshExecOptions } from './ssh-connection-utils'
import type { RemoteCommandDialect } from './ssh-remote-platform'
import type { SystemSshCommandChannel } from './system-ssh-command'

export type SshRelayRuntimeSystemSshConnection = Readonly<{
  usesSystemSshTransport: () => boolean
  exec: (command: string, options?: Pick<SshExecOptions, 'wrapCommand'>) => Promise<ClientChannel>
}>

export const SSH_RELAY_RUNTIME_SYSTEM_SSH_FILE_CHANNEL_LIMITS = Object.freeze({
  diagnosticBytes: 16 * 1024
})

type ChannelCloseCode = number | null
type ChannelCloseSignal = NodeJS.Signals | null | undefined

function validateInput(
  connection: SshRelayRuntimeSystemSshConnection,
  command: string,
  signal: AbortSignal,
  commandDialect: RemoteCommandDialect
): void {
  if (
    !connection ||
    typeof connection.usesSystemSshTransport !== 'function' ||
    typeof connection.exec !== 'function' ||
    typeof command !== 'string' ||
    command === '' ||
    !signal ||
    (commandDialect !== 'posix' && commandDialect !== 'powershell')
  ) {
    throw new Error('SSH relay runtime system SSH file channel input is invalid')
  }
  if (!connection.usesSystemSshTransport()) {
    throw new Error('SSH relay runtime system SSH file channel requires system SSH transport')
  }
  signal.throwIfAborted()
}

function validateChannel(channel: SystemSshCommandChannel): void {
  if (
    !channel ||
    typeof channel.on !== 'function' ||
    typeof channel.off !== 'function' ||
    typeof channel.resume !== 'function' ||
    typeof channel.close !== 'function' ||
    !channel.stdin ||
    typeof channel.stdin.write !== 'function' ||
    typeof channel.stdin.end !== 'function' ||
    !channel.stderr ||
    typeof channel.stderr.on !== 'function' ||
    typeof channel.stderr.off !== 'function'
  ) {
    throw new Error('SSH relay runtime system SSH command channel is invalid')
  }
}

function appendDiagnostic(
  chunks: Buffer[],
  size: number,
  data: Buffer | string
): { size: number; truncated: boolean } {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const remaining = SSH_RELAY_RUNTIME_SYSTEM_SSH_FILE_CHANNEL_LIMITS.diagnosticBytes - size
  if (remaining > 0) {
    // Why: copying avoids retaining an attacker-sized parent buffer for a small diagnostic prefix.
    const copied = Buffer.from(bytes.subarray(0, remaining))
    chunks.push(copied)
    size += copied.length
  }
  return { size, truncated: bytes.length > remaining }
}

function diagnosticText(chunks: readonly Buffer[], truncated: boolean): string {
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!truncated) {
    return text
  }
  return `${text}${text ? ' ' : ''}[truncated]`
}

function settlementError(
  code: ChannelCloseCode,
  signal: ChannelCloseSignal,
  diagnostic: string
): Error {
  const detail = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`
  return new Error(
    `SSH relay runtime system SSH file command failed (${detail})${diagnostic ? `: ${diagnostic}` : ''}`
  )
}

function waitForSettlement(channel: SystemSshCommandChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const diagnosticChunks: Buffer[] = []
    let diagnosticSize = 0
    let diagnosticTruncated = false
    let complete = false

    const cleanup = (): void => {
      channel.off('error', onError)
      channel.off('close', onClose)
      channel.stderr.off('data', onStderrData)
      channel.stderr.off('error', onError)
    }
    const settle = (callback: () => void): void => {
      if (complete) {
        return
      }
      complete = true
      cleanup()
      callback()
    }
    const onError = (error: Error): void => {
      settle(() => reject(error))
    }
    const onStderrData = (data: Buffer | string): void => {
      const appended = appendDiagnostic(diagnosticChunks, diagnosticSize, data)
      diagnosticSize = appended.size
      diagnosticTruncated ||= appended.truncated
    }
    const onClose = (code: ChannelCloseCode, signal?: ChannelCloseSignal): void => {
      settle(() => {
        if (code === 0) {
          resolve()
          return
        }
        reject(settlementError(code, signal, diagnosticText(diagnosticChunks, diagnosticTruncated)))
      })
    }

    channel.on('error', onError)
    channel.on('close', onClose)
    channel.stderr.on('data', onStderrData)
    channel.stderr.on('error', onError)
  })
}

function adaptChannel(channel: SystemSshCommandChannel): SshRelayRuntimeCommandFileChannel {
  validateChannel(channel)
  const settled = waitForSettlement(channel)
  const input = channel.stdin as unknown as {
    write: (chunk: Buffer, callback: (error?: Error) => void) => void
    end: () => void
  }
  let closeRequested = false
  let forceRequested = false

  // Why: the remote command has no stdout contract; draining prevents login noise from deadlocking.
  channel.resume()

  const write = (chunk: Buffer, callback: (error?: Error) => void): void => {
    input.write(chunk, callback)
  }
  const end = (): void => {
    input.end()
  }
  const requestClose = (): void => {
    if (closeRequested) {
      return
    }
    closeRequested = true
    channel.close()
  }
  const forceClose = (): void => {
    if (forceRequested) {
      return
    }
    forceRequested = true
    const process = channel._process
    if (!process) {
      throw new Error('SSH relay runtime system SSH file channel process ownership is missing')
    }
    if (process.exitCode !== null || process.signalCode !== null) {
      return
    }
    if (!process.kill('SIGKILL')) {
      throw new Error('SSH relay runtime system SSH file channel forced termination failed')
    }
  }

  return Object.freeze({ write, end, settled, requestClose, forceClose })
}

export async function openSshRelayRuntimeSystemSshFileChannel(
  connection: SshRelayRuntimeSystemSshConnection,
  command: string,
  signal: AbortSignal,
  commandDialect: RemoteCommandDialect
): Promise<SshRelayRuntimeCommandFileChannel> {
  validateInput(connection, command, signal, commandDialect)
  // Why: the file destination owns this signal's bounded teardown; forwarding it would double-kill.
  // Why: Windows staging already supplies a complete PowerShell command; POSIX still needs /bin/sh.
  const channel = (await (commandDialect === 'powershell'
    ? connection.exec(command, { wrapCommand: false })
    : connection.exec(command))) as SystemSshCommandChannel
  return adaptChannel(channel)
}
