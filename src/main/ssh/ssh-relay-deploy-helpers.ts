import type { ClientChannel } from 'ssh2'
import type { SshConnection } from './ssh-connection'
import type { SshExecOptions } from './ssh-connection-utils'
import { RELAY_SENTINEL, RELAY_SENTINEL_TIMEOUT_MS } from './relay-protocol'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import { buildRelayVersionMismatchError } from './ssh-relay-handshake-mismatch'

export { uploadFile, uploadDirectory, mkdirSftp } from './sftp-upload'

// ── Sentinel detection ────────────────────────────────────────────────

const MAX_RELAY_STARTUP_BUFFER_BYTES = 64 * 1024
const RELAY_SENTINEL_BUFFER = Buffer.from(RELAY_SENTINEL, 'utf-8')

export function waitForSentinel(channel: ClientChannel): Promise<MultiplexerTransport> {
  return new Promise<MultiplexerTransport>((resolve, reject) => {
    let sentinelReceived = false
    let settled = false
    let stderrOutput = ''
    let bufferedStdout: Buffer = Buffer.alloc(0)
    let closedAfterSentinel = false
    // Why: ssh2 fires 'exit' BEFORE 'close' with the remote exit code.
    // Capturing it here lets us translate exit-42 (relay handshake mismatch)
    // into a typed RelayVersionMismatchError so the relay-lost retry loop
    // can skip backoff for this terminal condition.
    let lastExitCode: number | null = null

    // Why: when the sentinel timeout fires we close the channel and wait a
    // short grace window for the 'close' handler to surface the typed
    // RelayVersionMismatchError if the remote --connect actually exited 42.
    // Settling here unconditionally would let a slow exit-42 (e.g. a remote
    // with congested SSH multiplex or a paused VM) be misclassified as a
    // generic timeout — which routes through the relay-lost retry backoff
    // and re-introduces the failure mode the typed error was meant to
    // prevent.
    const TIMEOUT_GRACE_MS = 500
    let timeoutFired = false
    let timeoutGraceTimer: ReturnType<typeof setTimeout> | null = null

    const timeout = setTimeout(() => {
      timeoutFired = true
      channel.close()
      timeoutGraceTimer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(
            new Error(
              `Relay failed to start within ${RELAY_SENTINEL_TIMEOUT_MS / 1000}s.${stderrOutput ? ` stderr: ${stderrOutput.trim()}` : ''}`
            )
          )
        }
      }, TIMEOUT_GRACE_MS)
    }, RELAY_SENTINEL_TIMEOUT_MS)

    const cancelTimers = (): void => {
      clearTimeout(timeout)
      if (timeoutGraceTimer) {
        clearTimeout(timeoutGraceTimer)
        timeoutGraceTimer = null
      }
    }

    channel.on('exit', (code: number | null) => {
      if (typeof code === 'number') {
        lastExitCode = code
      }
    })

    channel.stderr.on('data', (data: Buffer) => {
      stderrOutput += data.toString('utf-8')
      if (stderrOutput.length > MAX_RELAY_STARTUP_BUFFER_BYTES) {
        stderrOutput = stderrOutput.slice(-MAX_RELAY_STARTUP_BUFFER_BYTES)
      }
    })

    const dataCallbacks: ((data: Buffer) => void)[] = []
    const closeCallbacks: (() => void)[] = []

    const notifyClosed = (): void => {
      if (closedAfterSentinel) {
        return
      }
      closedAfterSentinel = true
      for (const cb of closeCallbacks) {
        cb()
      }
    }

    const failOrClose = (err: Error): void => {
      cancelTimers()
      if (!sentinelReceived) {
        if (!settled) {
          settled = true
          reject(err)
        }
        return
      }
      notifyClosed()
    }

    const failStartupOutputCap = (): void => {
      // Why: before the sentinel, stdout is untrusted startup noise; cap it
      // like stderr so a broken remote cannot grow memory until timeout.
      failOrClose(new Error('Relay startup output exceeded 64 KiB before ready sentinel'))
      channel.close()
    }

    // Why: SSH channel streams emit `error` when the remote host disappears.
    // Unhandled EventEmitter errors are process-fatal, so convert them into
    // startup rejection before the sentinel and transport close after it.
    channel.on('error', (err: Error) => failOrClose(err))
    channel.stderr.on('error', (err: Error) => failOrClose(err))

    channel.on('close', () => {
      if (!sentinelReceived) {
        cancelTimers()
        if (!settled) {
          settled = true
          // Why: a wire-handshake mismatch on the daemon side closes the
          // socket; --connect prints the mismatch detail to stderr and exits
          // with code 42 BEFORE writing the sentinel. Translate that into a
          // typed RelayVersionMismatchError so the retry loop in ssh.ts can
          // distinguish a recoverable transport drop from this terminal
          // condition and skip backoff. The check still wins over a fired
          // timeout because the timeout handler defers settling for a small
          // grace window so the close handler can deliver the exit code.
          const versionMismatchError = buildRelayVersionMismatchError(lastExitCode, stderrOutput)
          if (versionMismatchError) {
            reject(versionMismatchError)
            return
          }
          const timeoutSuffix = timeoutFired
            ? ` (after ${RELAY_SENTINEL_TIMEOUT_MS / 1000}s sentinel timeout)`
            : ''
          reject(
            new Error(
              `Relay process exited before ready${timeoutSuffix}.${stderrOutput ? ` stderr: ${stderrOutput.trim()}` : ''}`
            )
          )
        }
        return
      }
      notifyClosed()
    })

    // Why: data arriving in the same TCP chunk as the sentinel is buffered
    // here. It's delivered on the first onData registration rather than
    // immediately after resolve, because resolve schedules a microtask —
    // the caller's `await` hasn't resumed yet, so no callbacks are
    // registered when the synchronous code after resolve runs.
    let pendingAfterSentinel: Buffer | null = null

    channel.on('data', (data: Buffer) => {
      if (sentinelReceived) {
        if (dataCallbacks.length === 0) {
          pendingAfterSentinel = pendingAfterSentinel
            ? Buffer.concat([pendingAfterSentinel, data])
            : data
        } else {
          for (const cb of dataCallbacks) {
            cb(data)
          }
        }
        return
      }

      const searchableDataLength = Math.max(
        0,
        MAX_RELAY_STARTUP_BUFFER_BYTES - bufferedStdout.length + RELAY_SENTINEL_BUFFER.length
      )
      const searchableData = data.subarray(0, searchableDataLength)
      // Why: search only far enough to accept a sentinel at the cap boundary;
      // bytes after the sentinel are framed relay data and may be large.
      const startupStdout =
        bufferedStdout.length === 0
          ? searchableData
          : Buffer.concat([bufferedStdout, searchableData])
      const sentinelIdx = startupStdout.indexOf(RELAY_SENTINEL_BUFFER)

      if (sentinelIdx > MAX_RELAY_STARTUP_BUFFER_BYTES) {
        failStartupOutputCap()
        return
      }

      if (sentinelIdx !== -1) {
        sentinelReceived = true
        cancelTimers()

        const afterSentinelOffset =
          sentinelIdx + RELAY_SENTINEL_BUFFER.length - bufferedStdout.length
        const afterSentinel = data.subarray(Math.max(0, afterSentinelOffset))

        if (afterSentinel.length > 0) {
          pendingAfterSentinel = afterSentinel
        }
        settled = true

        const transport: MultiplexerTransport = {
          write: (buf: Buffer) => channel.stdin.write(buf),
          onData: (cb) => {
            dataCallbacks.push(cb)
            // Why: deliver buffered post-sentinel data to the first
            // subscriber. This is the multiplexer constructor, which
            // registers onData synchronously — the data is guaranteed
            // to reach the decoder before any other frames arrive.
            if (pendingAfterSentinel) {
              const buf = pendingAfterSentinel
              pendingAfterSentinel = null
              cb(buf)
            }
          },
          onClose: (cb) => {
            closeCallbacks.push(cb)
            if (closedAfterSentinel) {
              cb()
            }
          },
          close: () => {
            channel.close()
          }
        }

        resolve(transport)
        return
      }

      if (bufferedStdout.length + data.length > MAX_RELAY_STARTUP_BUFFER_BYTES) {
        failStartupOutputCap()
        return
      }

      bufferedStdout = bufferedStdout.length === 0 ? data : Buffer.concat([bufferedStdout, data])
    })
  })
}

// ── Remote command execution ──────────────────────────────────────────

const EXEC_TIMEOUT_MS = 30_000

export async function execCommand(
  conn: SshConnection,
  command: string,
  options?: SshExecOptions
): Promise<string> {
  const channel = await conn.exec(command, options)
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const cleanup = (): void => {
      clearTimeout(timeout)
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
    const fail = (err: Error): void => {
      settle(reject, err)
    }
    const onStdoutData = (data: Buffer): void => {
      stdout += data.toString('utf-8')
    }
    const onStderrData = (data: Buffer): void => {
      stderr += data.toString('utf-8')
    }
    const onClose = (code: number): void => {
      if (code !== 0) {
        settle(reject, new Error(`Command "${command}" failed (exit ${code}): ${stderr.trim()}`))
      } else {
        settle(resolve, stdout)
      }
    }
    const timeout = setTimeout(() => {
      channel.close()
      settle(reject, new Error(`Command "${command}" timed out after ${EXEC_TIMEOUT_MS / 1000}s`))
    }, EXEC_TIMEOUT_MS)

    // Why: remote reboot tears down exec channels with stream errors. Without
    // scoped listeners, Node treats those as uncaught exceptions.
    channel.on('error', fail)
    channel.stderr.on('error', fail)
    channel.on('data', onStdoutData)
    channel.stderr.on('data', onStderrData)
    channel.on('close', onClose)
  })
}
