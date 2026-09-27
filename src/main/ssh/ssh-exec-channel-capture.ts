import { StringDecoder } from 'node:string_decoder'
import type { SshConnectionManager } from './ssh-connection-manager'
import type { SshExecOptions } from './ssh-connection-utils'

export type SshExecConnection = NonNullable<ReturnType<SshConnectionManager['getConnection']>>

export type SshExecCapture = {
  stdout: string
  stderr: string
  exitCode: number | null
}

const STDERR_BYTE_LIMIT = 64 * 1024

type SshExecCaptureOptions = {
  timeoutMs: number
  timeoutMessage: string
  execOptions?: SshExecOptions | undefined
  // Why: bounds what a probe whose reply is bounded by design can retain; a directory listing must stay uncut.
  stdoutByteLimit?: number | undefined
}

/**
 * Drain one exec channel into raw output. Every exit code resolves: an exit code is data
 * ("the command ran and said no"), so whether it is a failure belongs to the caller.
 * Only transport loss and the timeout reject.
 */
export async function captureSshExecChannel(
  conn: SshExecConnection,
  command: string,
  options: SshExecCaptureOptions
): Promise<SshExecCapture> {
  const channel = options.execOptions
    ? await conn.exec(command, options.execOptions)
    : await conn.exec(command)
  const stdoutByteLimit = options.stdoutByteLimit ?? null

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stdoutBytes = 0
    let stderr = ''
    let stderrBytes = 0
    let exitCode: number | null = null
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      channel.off('data', onStdoutData)
      channel.stderr.off('data', onStderrData)
      channel.off('exit', onExit)
      channel.off('close', onClose)
      channel.off('error', onError)
      channel.stderr.off('error', onError)
    }
    const rejectOnce = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    const closeChannel = (): void => {
      const closable = channel as { close?: () => void; destroy?: () => void }
      try {
        if (typeof closable.close === 'function') {
          closable.close()
        } else if (typeof closable.destroy === 'function') {
          closable.destroy()
        }
      } catch {
        /* best effort */
      }
    }
    const onTimeout = (): void => {
      // Why: no relay deadline exists during a raw exec, so bound this channel or the caller hangs forever.
      rejectOnce(new Error(options.timeoutMessage))
      closeChannel()
    }
    const resolveOnce = (result: SshExecCapture): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }

    // Why decoders: a UTF-8 character can span two chunks; decoding each chunk alone corrupts it.
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const onStdoutData = (data: Buffer): void => {
      if (stdoutByteLimit === null) {
        stdout += stdoutDecoder.write(data)
        return
      }
      const remaining = stdoutByteLimit - stdoutBytes
      if (remaining <= 0) {
        return
      }
      // Why: cut on the byte budget so a flooding host cannot grow the buffer; a half line is dropped by the parser.
      const chunk = data.length > remaining ? data.subarray(0, remaining) : data
      stdoutBytes += chunk.length
      stdout += stdoutDecoder.write(chunk)
    }
    const onStderrData = (data: Buffer): void => {
      // Why: stderr only feeds error messages; a chatty or hostile host must not grow it without bound.
      const remaining = STDERR_BYTE_LIMIT - stderrBytes
      if (remaining <= 0) {
        return
      }
      const chunk = data.length > remaining ? data.subarray(0, remaining) : data
      stderrBytes += chunk.length
      stderr += stderrDecoder.write(chunk)
    }
    // `exit` fires before `close`; capturing the code is what lets a caller tell a failed command (that still printed output) from an empty reply.
    const onExit = (code: number | null): void => {
      exitCode = code
    }
    const onError = (error: Error): void => {
      rejectOnce(error)
    }
    const onClose = (): void => {
      resolveOnce({
        stdout: stdout + stdoutDecoder.end(),
        stderr: stderr + stderrDecoder.end(),
        exitCode
      })
    }

    channel.on('data', onStdoutData)
    channel.stderr.on('data', onStderrData)
    channel.on('exit', onExit)
    channel.on('close', onClose)
    // Why: SSH exec streams emit `error` on transport loss; without a scoped listener a disappearing remote can become process-fatal.
    channel.on('error', onError)
    channel.stderr.on('error', onError)
    timeout = setTimeout(onTimeout, options.timeoutMs)
    if (typeof timeout.unref === 'function') {
      timeout.unref()
    }
  })
}
