import type { ClientChannel } from 'ssh2'
import type { SshConnection } from './ssh-connection'
import { RELAY_SENTINEL, RELAY_SENTINEL_TIMEOUT_MS } from './relay-protocol'
import type { MultiplexerTransport } from './ssh-channel-multiplexer'

export { uploadFile, uploadDirectory, mkdirSftp } from './sftp-upload'

// ── Sentinel detection ────────────────────────────────────────────────

export function waitForSentinel(channel: ClientChannel): Promise<MultiplexerTransport> {
  return new Promise<MultiplexerTransport>((resolve, reject) => {
    let sentinelReceived = false
    let stderrOutput = ''
    let bufferedStdout = Buffer.alloc(0)
    let closedAfterSentinel = false

    const timeout = setTimeout(() => {
      if (!sentinelReceived) {
        channel.close()
        reject(
          new Error(
            `Relay failed to start within ${RELAY_SENTINEL_TIMEOUT_MS / 1000}s.${stderrOutput ? ` stderr: ${stderrOutput.trim()}` : ''}`
          )
        )
      }
    }, RELAY_SENTINEL_TIMEOUT_MS)

    const MAX_BUFFER_CAP = 64 * 1024
    channel.stderr.on('data', (data: Buffer) => {
      stderrOutput += data.toString('utf-8')
      if (stderrOutput.length > MAX_BUFFER_CAP) {
        stderrOutput = stderrOutput.slice(-MAX_BUFFER_CAP)
      }
    })

    const dataCallbacks: ((data: Buffer) => void)[] = []
    const closeCallbacks: (() => void)[] = []

    channel.on('close', () => {
      if (!sentinelReceived) {
        clearTimeout(timeout)
        reject(
          new Error(
            `Relay process exited before ready.${stderrOutput ? ` stderr: ${stderrOutput.trim()}` : ''}`
          )
        )
        return
      }
      closedAfterSentinel = true
      for (const cb of closeCallbacks) {
        cb()
      }
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
        clearTimeout(timeout)

        const afterSentinel = bufferedStdout.subarray(
          Buffer.byteLength(text.substring(0, sentinelIdx + RELAY_SENTINEL.length), 'utf-8')
        )

        if (afterSentinel.length > 0) {
          pendingAfterSentinel = afterSentinel
        }

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
