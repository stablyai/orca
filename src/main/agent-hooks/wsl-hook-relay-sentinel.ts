// Sentinel wait for the WSL agent-hook relay: consume the guest child's
// stdout until the READY sentinel, then hand the remaining stdio over as a
// MultiplexerTransport. WSL twin of the SSH deploy's waitForSentinel, over a
// ChildProcess instead of a ClientChannel.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import {
  HEADER_LENGTH,
  MAX_BUFFERED_FRAME_CHUNKS,
  MAX_MESSAGE_SIZE,
  RELAY_SENTINEL,
  RELAY_SENTINEL_TIMEOUT_MS
} from '../ssh/relay-protocol'
import type { MultiplexerTransport } from '../ssh/ssh-channel-multiplexer'

export const MAX_STARTUP_BUFFER_BYTES = 64 * 1024
const MAX_PENDING_RELAY_BYTES = (MAX_MESSAGE_SIZE + HEADER_LENGTH) * 2

// Why: without WSL_UTF8, wsl.exe's own messages arrive UTF-16LE; NUL bytes
// in breadcrumbs and the catastrophic-failure matcher must not depend on the
// env var having taken effect (older wsl.exe ignores it).
export function decodeWslText(value: string): string {
  return value.split(String.fromCharCode(0)).join('')
}

export type WslRelayStartupFailure = {
  kind: 'exit' | 'timeout'
  code: number | null
  stderr: string
}

/** Wait for the relay's ready sentinel on the child's stdout, then hand the
 *  remaining stdio over as a MultiplexerTransport. WSL twin of the SSH
 *  deploy's waitForSentinel, over a ChildProcess instead of a ClientChannel. */
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
    // Why: post-sentinel chunks queue until the mux registers onData, then
    // flush as a microtask — after the caller's synchronous wiring (the mux
    // constructor registers onData before the manager can add notification
    // handlers, so a synchronous flush could dispatch an early envelope to
    // zero handlers) yet before any subsequent stdout IO event, so the frame
    // decoder never sees chunks out of order. A setImmediate handoff would
    // NOT preserve that: it is a macrotask the next 'data' event can beat.
    const pendingChunks: Buffer[] = []
    let pendingChunkBytes = 0
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
      if (closedNotified) {
        return
      }
      if (dataCallbacks.length === 0) {
        if (
          chunk.length > MAX_PENDING_RELAY_BYTES - pendingChunkBytes ||
          pendingChunks.length >= MAX_BUFFERED_FRAME_CHUNKS
        ) {
          pendingChunks.length = 0
          pendingChunkBytes = 0
          notifyClosed()
          child.kill()
          return
        }
        pendingChunks.push(chunk)
        pendingChunkBytes += chunk.length
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
      const searchableLength = Math.max(
        0,
        MAX_STARTUP_BUFFER_BYTES - stdoutBuffer.length + sentinel.length
      )
      const searchableChunk = chunk.subarray(0, searchableLength)
      const startupOutput =
        stdoutBuffer.length === 0 ? searchableChunk : Buffer.concat([stdoutBuffer, searchableChunk])
      const idx = startupOutput.indexOf(sentinel)
      if (idx === -1) {
        // Why: pre-sentinel stdout is untrusted startup noise; cap it so a
        // broken guest cannot grow memory until the timeout fires.
        if (startupOutput.length > MAX_STARTUP_BUFFER_BYTES) {
          child.kill()
          fail({ kind: 'exit', code: null, stderr: 'startup output exceeded 64 KiB' })
        } else {
          stdoutBuffer = startupOutput
        }
        return
      }
      sentinelSeen = true
      settled = true
      clearTimeout(timeout)
      const trailingOffset = idx + sentinel.length - stdoutBuffer.length
      const trailing = chunk.subarray(Math.max(0, trailingOffset))
      if (trailing.length > 0) {
        dispatch(trailing)
      }
      const transport: MultiplexerTransport = {
        write: (data) => {
          try {
            child.stdin.write(data)
          } catch {
            // Channel already closing — mux close handling takes over.
          }
        },
        onData: (cb) => {
          dataCallbacks.push(cb)
          if (dataCallbacks.length === 1 && pendingChunks.length > 0) {
            queueMicrotask(() => {
              for (const pending of pendingChunks.splice(0)) {
                pendingChunkBytes -= pending.length
                for (const dataCb of dataCallbacks) {
                  dataCb(pending)
                }
              }
            })
          }
        },
        onClose: (cb) => {
          if (closedNotified) {
            queueMicrotask(cb)
          } else {
            closeCallbacks.push(cb)
          }
        },
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
