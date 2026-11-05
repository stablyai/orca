import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { RELAY_SENTINEL, RELAY_SENTINEL_TIMEOUT_MS } from '../ssh/remote-exec/remote-frame-protocol'
import type { MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'

export const MAX_STARTUP_BUFFER_BYTES = 64 * 1024

// Older wsl.exe ignores WSL_UTF8; strip UTF-16LE ASCII padding before matching failure text.
export function decodeWslText(value: string): string {
  return value.split(String.fromCharCode(0)).join('')
}

export type WslRelayStartupFailure = {
  kind: 'exit' | 'timeout'
  code: number | null
  stderr: string
}

/** Hand post-sentinel bytes to the mux while preserving wire order. */
export function waitForWslRelaySentinel(
  child: ChildProcessWithoutNullStreams
): Promise<MultiplexerTransport> {
  return new Promise((resolve, reject) => {
    let settled = false
    let sentinelSeen = false
    let stdoutBuffer: Buffer = Buffer.alloc(0)
    let stderrOutput = ''
    let exitCode: number | null = null
    const sentinel = Buffer.from(RELAY_SENTINEL, 'utf8')
    const dataCallbacks: ((data: Buffer) => void)[] = []
    const closeCallbacks: (() => void)[] = []
    // Flush in a microtask after handler wiring but before later stdout events can overtake queued bytes.
    const pendingChunks: Buffer[] = []
    let closedNotified = false

    const fail = (failure: WslRelayStartupFailure): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      reject(Object.assign(new Error(formatStartupFailure(failure)), { startup: failure }))
    }

    const timeout = setTimeout(() => {
      child.kill()
      fail({ kind: 'timeout', code: null, stderr: stderrOutput })
    }, RELAY_SENTINEL_TIMEOUT_MS)

    const notifyClosed = (): void => {
      if (!closedNotified) {
        closedNotified = true
        for (const cb of closeCallbacks) {
          cb()
        }
      }
    }

    const dispatch = (chunk: Buffer): void => {
      if (dataCallbacks.length === 0) {
        pendingChunks.push(chunk)
        return
      }
      for (const cb of dataCallbacks) {
        cb(chunk)
      }
    }

    child.stderr.on('data', (d: Buffer) => {
      stderrOutput = (stderrOutput + decodeWslText(d.toString('utf8'))).slice(
        -MAX_STARTUP_BUFFER_BYTES
      )
    })
    child.on('error', (err) =>
      fail({ kind: 'exit', code: null, stderr: `${stderrOutput}\n${err.message}` })
    )
    // Async EPIPE bypasses write try/catch; listen so guest death cannot crash the host.
    child.stdin.on('error', () => {})
    child.on('exit', (code) => {
      exitCode = code
    })
    child.on('close', (code) => {
      if (sentinelSeen) {
        notifyClosed()
        return
      }
      fail({ kind: 'exit', code: code ?? exitCode, stderr: stderrOutput })
    })

    child.stdout.on('data', (chunk: Buffer) => {
      if (sentinelSeen) {
        dispatch(chunk)
        return
      }
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk])
      const idx = stdoutBuffer.indexOf(sentinel)
      if (idx === -1) {
        // Bound untrusted startup noise until the sentinel arrives.
        if (stdoutBuffer.length > MAX_STARTUP_BUFFER_BYTES) {
          child.kill()
          fail({ kind: 'exit', code: null, stderr: 'startup output exceeded 64 KiB' })
        }
        return
      }
      sentinelSeen = true
      settled = true
      clearTimeout(timeout)
      const trailing = stdoutBuffer.subarray(idx + sentinel.length)
      if (trailing.length > 0) {
        pendingChunks.push(trailing)
      }
      const transport: MultiplexerTransport = {
        write: (data, onSettled) => {
          return child.stdin.write(data, (error?: Error | null) => {
            onSettled?.(error ? { ok: false, error } : { ok: true })
          })
        },
        supportsWriteSettlement: true,
        onDrain: (cb) => {
          child.stdin.on('drain', cb)
          return () => child.stdin.off('drain', cb)
        },
        onData: (cb) => {
          dataCallbacks.push(cb)
          if (dataCallbacks.length === 1 && pendingChunks.length > 0) {
            queueMicrotask(() => {
              for (const pending of pendingChunks.splice(0)) {
                for (const dataCb of dataCallbacks) {
                  dataCb(pending)
                }
              }
            })
          }
        },
        onClose: (cb) => closeCallbacks.push(cb),
        pauseReads: () => child.stdout.pause(),
        resumeReads: () => child.stdout.resume(),
        close: () => child.kill()
      }
      resolve(transport)
    })
  })
}

function formatStartupFailure(failure: WslRelayStartupFailure): string {
  const detail = failure.stderr.trim()
  if (failure.kind === 'timeout') {
    return `WSL hook relay did not become ready within ${RELAY_SENTINEL_TIMEOUT_MS / 1000}s${detail ? `: ${detail}` : ''}`
  }
  return `WSL hook relay exited (code ${failure.code ?? 'unknown'})${detail ? `: ${detail}` : ''}`
}
