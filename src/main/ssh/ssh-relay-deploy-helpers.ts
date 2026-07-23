import type { ClientChannel } from 'ssh2'
import { createSshOperationAbortError } from './ssh-connection-utils'
import {
  HEADER_LENGTH,
  MAX_BUFFERED_FRAME_CHUNKS,
  MAX_MESSAGE_SIZE,
  RELAY_SENTINEL,
  RELAY_SENTINEL_TIMEOUT_MS
} from './relay-protocol'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import { buildRelayVersionMismatchError } from './ssh-relay-handshake-mismatch'

export { uploadFile, uploadDirectory, mkdirSftp } from './sftp-upload'
export { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'

// ── Sentinel detection ────────────────────────────────────────────────

const MAX_RELAY_STARTUP_BUFFER_BYTES = 64 * 1024
// One maximum frame may be coalesced with the start of the next.
const MAX_PENDING_RELAY_BYTES = (MAX_MESSAGE_SIZE + HEADER_LENGTH) * 2
const RELAY_SENTINEL_BUFFER = Buffer.from(RELAY_SENTINEL, 'utf-8')

export function waitForSentinel(
  channel: ClientChannel,
  signal?: AbortSignal
): Promise<MultiplexerTransport> {
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
      timeoutGraceTimer = setTimeout(() => {
        rejectStartup(
          new Error(
            `Relay failed to start within ${RELAY_SENTINEL_TIMEOUT_MS / 1000}s.${stderrOutput ? ` stderr: ${stderrOutput.trim()}` : ''}`
          )
        )
      }, TIMEOUT_GRACE_MS)
      channel.close()
    }, RELAY_SENTINEL_TIMEOUT_MS)

    const cancelTimers = (): void => {
      clearTimeout(timeout)
      if (timeoutGraceTimer) {
        clearTimeout(timeoutGraceTimer)
        timeoutGraceTimer = null
      }
    }
    const cleanupStartup = (): void => {
      cancelTimers()
      signal?.removeEventListener('abort', onAbort)
    }
    const rejectStartup = (err: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupStartup()
      reject(err)
    }
    const onAbort = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupStartup()
      channel.close()
      reject(createSshOperationAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
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
      if (!sentinelReceived) {
        rejectStartup(err)
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
        if (!settled) {
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
            rejectStartup(versionMismatchError)
            return
          }
          const timeoutSuffix = timeoutFired
            ? ` (after ${RELAY_SENTINEL_TIMEOUT_MS / 1000}s sentinel timeout)`
            : ''
          rejectStartup(
            new Error(
              `Relay process exited before ready${timeoutSuffix}.${stderrOutput ? ` stderr: ${stderrOutput.trim()}` : ''}`
            )
          )
        }
        return
      }
      notifyClosed()
    })

    // The caller cannot subscribe until the resolved promise resumes.
    let pendingAfterSentinel: Buffer[] = []
    let pendingAfterSentinelBytes = 0

    const bufferAfterSentinel = (data: Buffer): void => {
      if (closedAfterSentinel) {
        return
      }
      if (
        data.length > MAX_PENDING_RELAY_BYTES - pendingAfterSentinelBytes ||
        pendingAfterSentinel.length >= MAX_BUFFERED_FRAME_CHUNKS
      ) {
        pendingAfterSentinel = []
        pendingAfterSentinelBytes = 0
        notifyClosed()
        channel.close()
        return
      }
      pendingAfterSentinel.push(data)
      pendingAfterSentinelBytes += data.length
    }

    channel.on('data', (data: Buffer) => {
      if (sentinelReceived) {
        if (closedAfterSentinel) {
          return
        }
        if (dataCallbacks.length === 0) {
          bufferAfterSentinel(data)
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
        settled = true
        cleanupStartup()

        const afterSentinelOffset =
          sentinelIdx + RELAY_SENTINEL_BUFFER.length - bufferedStdout.length
        const afterSentinel = data.subarray(Math.max(0, afterSentinelOffset))

        if (afterSentinel.length > 0) {
          bufferAfterSentinel(afterSentinel)
        }
        const transport: MultiplexerTransport = {
          write: (buf: Buffer) => channel.stdin.write(buf),
          onData: (cb) => {
            dataCallbacks.push(cb)
            if (pendingAfterSentinel.length > 0) {
              const buf = Buffer.concat(pendingAfterSentinel, pendingAfterSentinelBytes)
              pendingAfterSentinel = []
              pendingAfterSentinelBytes = 0
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
