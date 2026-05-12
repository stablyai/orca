import type { ClientChannel } from 'ssh2'
import type { SshConnection } from './ssh-connection'
import { RELAY_SENTINEL, RELAY_SENTINEL_TIMEOUT_MS } from './relay-protocol'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'
import {
  RelayVersionMismatchError,
  RELAY_EXIT_CODE_VERSION_MISMATCH
} from './ssh-relay-version-mismatch-error'

export { uploadFile, uploadDirectory, mkdirSftp } from './sftp-upload'

// ── Sentinel detection ────────────────────────────────────────────────

export function waitForSentinel(channel: ClientChannel): Promise<MultiplexerTransport> {
  return new Promise<MultiplexerTransport>((resolve, reject) => {
    let sentinelReceived = false
    let settled = false
    let stderrOutput = ''
    let bufferedStdout = Buffer.alloc(0)
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

    const MAX_BUFFER_CAP = 64 * 1024
    channel.stderr.on('data', (data: Buffer) => {
      stderrOutput += data.toString('utf-8')
      if (stderrOutput.length > MAX_BUFFER_CAP) {
        stderrOutput = stderrOutput.slice(-MAX_BUFFER_CAP)
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
          if (lastExitCode === RELAY_EXIT_CODE_VERSION_MISMATCH) {
            const { expected, got } = parseHandshakeMismatchStderr(stderrOutput)
            reject(new RelayVersionMismatchError(expected, got, stderrOutput.trim()))
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

      bufferedStdout = Buffer.concat([bufferedStdout, data])
      const text = bufferedStdout.toString('utf-8')
      const sentinelIdx = text.indexOf(RELAY_SENTINEL)

      if (sentinelIdx !== -1) {
        sentinelReceived = true
        cancelTimers()

        const afterSentinel = bufferedStdout.subarray(
          Buffer.byteLength(text.substring(0, sentinelIdx + RELAY_SENTINEL.length), 'utf-8')
        )

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
      }
    })
  })
}

// ── Remote command execution ──────────────────────────────────────────

const EXEC_TIMEOUT_MS = 30_000

export async function execCommand(conn: SshConnection, command: string): Promise<string> {
  const channel = await conn.exec(command)
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        channel.close()
        reject(new Error(`Command "${command}" timed out after ${EXEC_TIMEOUT_MS / 1000}s`))
      }
    }, EXEC_TIMEOUT_MS)

    const fail = (err: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      reject(err)
    }

    // Why: remote reboot tears down exec channels with stream errors. Without
    // scoped listeners, Node treats those as uncaught exceptions.
    channel.on('error', fail)
    channel.stderr.on('error', fail)
    channel.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8')
    })
    channel.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8')
    })
    channel.on('close', (code: number) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`Command "${command}" failed (exit ${code}): ${stderr.trim()}`))
      } else {
        resolve(stdout)
      }
    })
  })
}

// ── Remote Node.js resolution ─────────────────────────────────────────

// Why: non-login SSH shells (the default for `exec`) don't source
// .bashrc/.zshrc, so node installed via nvm/fnm/Homebrew isn't in PATH.
// We try common locations and fall back to a login-shell `which`.
export async function resolveRemoteNodePath(conn: SshConnection): Promise<string> {
  // Why: non-login SSH exec channels don't source .bashrc/.zshrc, so node
  // installed via nvm/fnm/Homebrew may not be in PATH. We probe common
  // locations directly, then fall back to sourcing the profile explicitly.
  // The glob in $HOME/.nvm/... is expanded by the shell, not by `command -v`.
  const script = [
    'command -v node 2>/dev/null',
    'command -v /usr/local/bin/node 2>/dev/null',
    'command -v /opt/homebrew/bin/node 2>/dev/null',
    // Why: nvm installs into a versioned directory. `ls -1` sorts
    // alphabetically, which misorders versions (e.g. v9 > v18). Pipe
    // through `sort -V` (version sort) so we pick the highest version.
    'ls -1 $HOME/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1',
    'command -v $HOME/.local/bin/node 2>/dev/null',
    'command -v $HOME/.fnm/aliases/default/bin/node 2>/dev/null'
  ].join(' || ')

  try {
    const result = await execCommand(conn, script)
    const nodePath = result.trim().split('\n')[0]
    if (nodePath) {
      console.log(`[ssh-relay] Found node at: ${nodePath}`)
      return nodePath
    }
  } catch {
    // Fall through to login shell attempt
  }

  // Why: last resort — source the full login profile. This is separated into
  // its own exec because `bash -lc` can hang on remotes with interactive
  // shell configs (conda prompts, etc.). If this times out, the error message
  // from execCommand will tell us it was the login shell attempt.
  try {
    console.log('[ssh-relay] Trying login shell to find node...')
    const result = await execCommand(conn, "bash -lc 'command -v node' 2>/dev/null")
    const nodePath = result.trim().split('\n')[0]
    if (nodePath) {
      console.log(`[ssh-relay] Found node via login shell: ${nodePath}`)
      return nodePath
    }
  } catch {
    // Fall through
  }

  throw new Error(
    'Node.js not found on remote host. Orca relay requires Node.js 18+. ' +
      'Install Node.js on the remote and try again.'
  )
}

// Why: extract the expected/got version pair from --connect's stderr line
// "Handshake mismatch: expected=<x>, daemon=<y>" so the typed error carries
// actionable detail. Best-effort: returns undefined fields if the regex
// doesn't match, preserving the raw stderr verbatim for diagnostics.
function parseHandshakeMismatchStderr(stderr: string): {
  expected: string | undefined
  got: string | undefined
} {
  const match = /expected=([^,\s]+),\s*daemon=([^\s;]+)/.exec(stderr)
  if (!match) {
    return { expected: undefined, got: undefined }
  }
  return { expected: match[1], got: match[2] }
}
