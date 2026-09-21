import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { extractCodexAuthError } from '../../shared/codex-auth-errors'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { cleanupHiddenRateLimitPty, registerHiddenRateLimitPty } from './hidden-pty-cleanup'
import type { CodexRateLimitFetchOptions } from './codex-rate-limit-fetch-options'
import { abortedCodexRateLimitResult } from './codex-rate-limit-fetch-result'
import {
  hasCodexPtyRateLimit,
  parseCodexPtyStatus,
  stripCodexPtyControlSequences
} from './codex-pty-status-parser'

const PTY_TIMEOUT_MS = 15_000
const PTY_STATUS_NUDGE_MS = 2_500
const PTY_STATUS_ENTER_DELAY_MS = 350
const PTY_STATUS_ENTER_RETRY_MS = 3_000
const MAX_DIAGNOSTIC_OUTPUT_LENGTH = 100_000

export type CodexPtyRateLimitCommand = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export async function fetchCodexRateLimitsViaPty(
  resolveCommand: () => CodexPtyRateLimitCommand,
  options?: CodexRateLimitFetchOptions
): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  const pty = await import('node-pty')
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  const command = resolveCommand()

  return new Promise<ProviderRateLimits>((resolve) => {
    let output = ''
    let resolved = false
    let sentStatus = false
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const term = pty.spawn(command.command, command.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: command.cwd,
      env: command.env
    })
    const termDisposables: { dispose: () => void }[] = [registerHiddenRateLimitPty(term)]

    let statusEnter: ReturnType<typeof setTimeout> | null = null
    let statusNudge: ReturnType<typeof setTimeout> | null = null
    function sendStatusCommand(): void {
      sentStatus = true
      if (statusNudge) {
        clearTimeout(statusNudge)
        statusNudge = null
      }
      term.write('/status')
      statusEnter = setTimeout(() => {
        statusEnter = null
        term.write('\r')
        statusEnter = setTimeout(() => {
          statusEnter = null
          if (!resolved && !settleTimer) {
            term.write('\r')
          }
        }, PTY_STATUS_ENTER_RETRY_MS)
      }, PTY_STATUS_ENTER_DELAY_MS)
    }

    function armStatusNudge(): void {
      if (statusNudge || sentStatus || resolved) {
        return
      }
      statusNudge = setTimeout(() => {
        statusNudge = null
        if (!resolved && !sentStatus) {
          sendStatusCommand()
        }
      }, PTY_STATUS_NUDGE_MS)
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

    function clearSettleTimers(): void {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
    }

    function settleAborted(): void {
      if (resolved) {
        return
      }
      resolved = true
      clearSettleTimers()
      cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
      resolve(abortedCodexRateLimitResult())
    }

    if (options?.signal) {
      if (options.signal.aborted) {
        settleAborted()
        return
      }
      options.signal.addEventListener('abort', settleAborted, { once: true })
      termDisposables.push({
        dispose: () => options.signal?.removeEventListener('abort', settleAborted)
      })
    }

    timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        clearSettleTimers()
        cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
        resolve({
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: extractCodexAuthError(output) ?? withMacTailscaleDnsHint('PTY timeout', output),
          status: 'error'
        })
      }
    }, PTY_TIMEOUT_MS)

    const onDataDisposable = term.onData((data) => {
      output += data
      if (output.length > MAX_DIAGNOSTIC_OUTPUT_LENGTH) {
        output = output.slice(-MAX_DIAGNOSTIC_OUTPUT_LENGTH)
      }

      const authError = extractCodexAuthError(output)
      if (authError) {
        resolved = true
        clearSettleTimers()
        cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
        resolve({
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: authError,
          status: 'error'
        })
        return
      }

      armStatusNudge()
      if (!sentStatus && /[>›]\s*$/.test(data)) {
        sendStatusCommand()
        return
      }
      const probe = sentStatus && !settleTimer ? stripCodexPtyControlSequences(output) : null
      if (probe !== null && hasCodexPtyRateLimit(probe)) {
        settleTimer = setTimeout(() => {
          settleTimer = null
          if (resolved) {
            return
          }
          resolved = true
          clearSettleTimers()
          cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
          const clean = stripCodexPtyControlSequences(output)
          const { session, weekly } = parseCodexPtyStatus(clean)
          resolve({
            provider: 'codex',
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
      }
    })
    if (onDataDisposable) {
      termDisposables.push(onDataDisposable)
    }

    const onExitDisposable = term.onExit(() => {
      cleanupHiddenRateLimitPty(term, termDisposables, { kill: false })
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
      if (!resolved) {
        resolved = true
        if (timeout) {
          clearTimeout(timeout)
        }
        const clean = stripCodexPtyControlSequences(output)
        const { session, weekly } = parseCodexPtyStatus(clean)
        resolve({
          provider: 'codex',
          session,
          weekly,
          updatedAt: Date.now(),
          error:
            session || weekly
              ? null
              : (extractCodexAuthError(clean) ??
                withMacTailscaleDnsHint('CLI exited before status was available', clean)),
          status: session || weekly ? 'ok' : 'error'
        })
      }
    })
    if (onExitDisposable) {
      termDisposables.push(onExitDisposable)
    }
  })
}
