import type { ClientChannel } from 'ssh2'
import { createSshOperationAbortError } from '../connection/ssh-exec-options'
import { RELAY_SENTINEL, RELAY_SENTINEL_TIMEOUT_MS } from '../remote-exec/remote-frame-protocol'
import type { MultiplexerTransport } from '../ssh-channel-multiplexer'
import { buildRelayHandshakeRefusalError } from './ssh-relay-handshake-mismatch'

const MAX_RELAY_STARTUP_BUFFER_BYTES = 64 * 1024
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
    // ssh2 emits exit before close; retain typed handshake refusals so retry logic skips transport backoff.
    let lastExitCode: number | null = null

    // After timeout, allow close 500ms to report typed exit 42/43 before settling a generic timeout.
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
      // Cap untrusted pre-sentinel stdout like stderr to bound memory until timeout.
      failOrClose(new Error('Relay startup output exceeded 64 KiB before ready sentinel'))
      channel.close()
    }

    // Channel errors must reject startup or close transport; unhandled EventEmitter errors are process-fatal.
    channel.on('error', (err: Error) => failOrClose(err))
    channel.stderr.on('error', (err: Error) => failOrClose(err))

    channel.on('close', () => {
      if (!sentinelReceived) {
        if (!settled) {
          // Pre-sentinel exit 42/43 is a terminal handshake refusal, even within the timeout grace window.
          const refusal = buildRelayHandshakeRefusalError(lastExitCode, stderrOutput)
          if (refusal) {
            rejectStartup(refusal)
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

    // Buffer post-sentinel bytes until await resumes and the multiplexer subscribes; resolve alone only schedules a microtask.
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
      // Cap startup noise only; a sentinel at the boundary may precede large framed relay data.
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
        bufferedStdout = Buffer.alloc(0)

        if (afterSentinel.length > 0) {
          pendingAfterSentinel = afterSentinel
        }
        const transport: MultiplexerTransport = {
          write: (buf: Buffer, onSettled) => {
            return channel.stdin.write(buf, (error?: Error | null) => {
              onSettled?.(error ? { ok: false, error } : { ok: true })
            })
          },
          supportsWriteSettlement: true,
          onDrain: (cb) => {
            channel.stdin.on('drain', cb)
            return () => channel.stdin.off('drain', cb)
          },
          onData: (cb) => {
            dataCallbacks.push(cb)
            // Deliver buffered bytes to the first subscriber before newer frames reach its decoder.
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
          pauseReads: () => channel.pause(),
          resumeReads: () => channel.resume(),
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

      bufferedStdout = startupStdout
    })
  })
}
