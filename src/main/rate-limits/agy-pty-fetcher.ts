import type { IPty } from 'node-pty'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  FIVE_HOUR_RE,
  WEEKLY_RE,
  parsePtyStatus,
  stripPtyControlSequences
} from './agy-pty-status-parser'
import { cleanupHiddenRateLimitPty, registerHiddenRateLimitPty } from './hidden-pty-cleanup'
import { resolveHiddenRateLimitPtyCwd } from './hidden-rate-limit-pty-cwd'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'

export async function fetchAntigravityRateLimitsViaPty(
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  const pty = await import('node-pty')

  if (signal?.aborted) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Aborted',
      status: 'error'
    }
  }

  const spawnFile = process.platform === 'win32' ? 'cmd.exe' : 'agy'
  const spawnArgs = process.platform === 'win32' ? ['/d', '/c', 'agy'] : []

  return new Promise<ProviderRateLimits>((resolve) => {
    let output = ''
    let resolved = false
    let sentStatus = false
    let postCommandOffset = 0
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    let term: IPty
    let termDisposables: { dispose: () => void }[] = []
    try {
      term = pty.spawn(spawnFile, spawnArgs, {
        name: 'xterm-256color',
        cols: 200,
        rows: 100,
        cwd: resolveHiddenRateLimitPtyCwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        }
      })
      termDisposables = [registerHiddenRateLimitPty(term)]
    } catch (err) {
      resolve({
        provider: 'antigravity',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: `Failed to spawn CLI: ${err instanceof Error ? err.message : String(err)}`,
        status: 'unavailable'
      })
      return
    }

    let statusEnter: ReturnType<typeof setTimeout> | null = null
    function sendStatusCommand(): void {
      sentStatus = true
      postCommandOffset = output.length
      if (statusNudge) {
        clearTimeout(statusNudge)
        statusNudge = null
      }
      term.write('/usage')
      statusEnter = setTimeout(() => {
        statusEnter = null
        term.write('\r')
        statusEnter = setTimeout(() => {
          statusEnter = null
          if (!resolved && !settleTimer) {
            term.write('\r')
          }
        }, 3000)
      }, 350)
    }

    let statusNudge: ReturnType<typeof setTimeout> | null = null
    function armStatusNudge(): void {
      if (sentStatus || resolved) {
        return
      }
      // Reset on every data event so the nudge only fires after 2.5s of silence
      if (statusNudge) {
        clearTimeout(statusNudge)
      }
      statusNudge = setTimeout(() => {
        statusNudge = null
        if (!resolved && !sentStatus) {
          sendStatusCommand()
        }
      }, 2500)
    }
    termDisposables.push({
      dispose: () => {
        if (statusNudge) {
          clearTimeout(statusNudge)
          statusNudge = null
        }
        if (statusEnter) {
          clearTimeout(statusEnter)
          statusEnter = null
        }
      }
    })

    function settleAborted(): void {
      if (resolved) {
        return
      }
      resolved = true
      if (timeout) {
        clearTimeout(timeout)
      }
      if (settleTimer) {
        clearTimeout(settleTimer)
      }
      cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
      resolve({
        provider: 'antigravity',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Aborted',
        status: 'error'
      })
    }

    if (signal) {
      if (signal.aborted) {
        settleAborted()
        return
      }
      signal.addEventListener('abort', settleAborted, { once: true })
      termDisposables.push({
        dispose: () => signal.removeEventListener('abort', settleAborted)
      })
    }

    timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        if (settleTimer) {
          clearTimeout(settleTimer)
        }
        cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
        resolve({
          provider: 'antigravity',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: withMacTailscaleDnsHint('PTY timeout', output),
          status: 'error'
        })
      }
    }, 15000)

    const onDataDisposable = term.onData((data) => {
      output += data
      if (output.length > 100000) {
        output = output.slice(-100000)
      }

      armStatusNudge()

      if (!sentStatus) {
        // agy sends the '>' prompt mid-chunk followed by status-bar lines, so
        // checking only the end of data or stripped output misses it. Instead,
        // look for a line that is just the prompt character in the accumulated output.
        const stripped = stripPtyControlSequences(output)
        if (/[>›]\s*$/.test(data) || /^[>›]\s*$/m.test(stripped)) {
          sendStatusCommand()
          return
        }
      }

      const probe =
        sentStatus && !settleTimer
          ? stripPtyControlSequences(output.slice(postCommandOffset))
          : null
      if (probe !== null) {
        if (FIVE_HOUR_RE.test(probe) || WEEKLY_RE.test(probe)) {
          settleTimer = setTimeout(() => {
            settleTimer = null
            if (resolved) {
              return
            }
            resolved = true
            if (timeout) {
              clearTimeout(timeout)
            }
            cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })

            const clean = stripPtyControlSequences(output)
            const { session, weekly } = parsePtyStatus(clean)

            resolve({
              provider: 'antigravity',
              session,
              weekly,
              updatedAt: Date.now(),
              error:
                session || weekly
                  ? null
                  : withMacTailscaleDnsHint('Failed to parse CLI output', clean),
              status: session || weekly ? 'ok' : 'error'
            })
          }, 500)
        } else if (/not signed in|Token refresh failed/i.test(probe)) {
          // Fast-fail if CLI reports it is not signed in or failed to refresh its token
          if (resolved) {
            return
          }
          resolved = true
          if (timeout) {
            clearTimeout(timeout)
          }
          if (settleTimer) {
            clearTimeout(settleTimer)
          }
          cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
          resolve({
            provider: 'antigravity',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: /Token refresh failed/i.test(probe)
              ? 'Token refresh failed'
              : 'Antigravity CLI not signed in',
            status: 'error'
          })
        }
      }
    })
    if (onDataDisposable) {
      termDisposables.push(onDataDisposable)
    }

    const onExitDisposable = term.onExit(() => {
      cleanupHiddenRateLimitPty(term, termDisposables, { kill: false })
      if (settleTimer) {
        clearTimeout(settleTimer)
      }
      if (!resolved) {
        resolved = true
        if (timeout) {
          clearTimeout(timeout)
        }
        const clean = stripPtyControlSequences(output)
        const { session, weekly } = parsePtyStatus(clean)
        resolve({
          provider: 'antigravity',
          session,
          weekly,
          updatedAt: Date.now(),
          error:
            session || weekly
              ? null
              : withMacTailscaleDnsHint('CLI exited before status was available', clean),
          status: session || weekly ? 'ok' : 'error'
        })
      }
    })
    if (onExitDisposable) {
      termDisposables.push(onExitDisposable)
    }
  })
}
