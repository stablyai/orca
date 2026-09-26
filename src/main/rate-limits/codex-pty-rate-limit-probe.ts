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
// Why: Codex 0.144+ often answers the first /status with an async placeholder
// ("refresh requested; run /status again shortly") before percent limits appear.
const STATUS_REFRESH_PENDING_RE = /refresh requested|run\s+\/status\s+again/i
const STATUS_RETRY_DELAY_MS = 750
const MAX_STATUS_ATTEMPTS = 2
const STATUS_REFRESH_PENDING_ERROR = 'Codex usage refresh still pending — try again shortly'

export type CodexPtyRateLimitCommand = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

function appendDiagnosticOutput(buffer: string, data: string): string {
  const next = buffer + data
  return next.length > MAX_DIAGNOSTIC_OUTPUT_LENGTH
    ? next.slice(-MAX_DIAGNOSTIC_OUTPUT_LENGTH)
    : next
}

function describePtyStatusFailure(
  output: string,
  latestStatusOutput: string,
  fallback: string
): string {
  const clean = stripCodexPtyControlSequences(output)
  const authError = extractCodexAuthError(clean)
  if (authError) {
    return authError
  }
  // Why: distinguish "CLI never answered" from "CLI answered but limits were
  // still pending" so the status bar does not blame a false PTY hang. Only the
  // latest /status counts, so a retried attempt's own failure is not masked.
  if (STATUS_REFRESH_PENDING_RE.test(stripCodexPtyControlSequences(latestStatusOutput))) {
    return STATUS_REFRESH_PENDING_ERROR
  }
  return withMacTailscaleDnsHint(fallback, clean)
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
    // Output since the most recent /status was sent.
    let latestStatusOutput = ''
    let resolved = false
    let sentStatus = false
    let statusAttempts = 0
    let statusRetryTimer: ReturnType<typeof setTimeout> | null = null
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
      statusAttempts += 1
      latestStatusOutput = ''
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
      if (statusRetryTimer) {
        clearTimeout(statusRetryTimer)
        statusRetryTimer = null
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

    function scheduleStatusRetry(): void {
      if (resolved || statusRetryTimer || statusAttempts >= MAX_STATUS_ATTEMPTS) {
        return
      }
      // Why: first /status often only queues a backend refresh; one delayed
      // retry is enough for the second panel to include percent limits.
      statusRetryTimer = setTimeout(() => {
        statusRetryTimer = null
        if (resolved || statusAttempts >= MAX_STATUS_ATTEMPTS) {
          return
        }
        sendStatusCommand()
      }, STATUS_RETRY_DELAY_MS)
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
          error: describePtyStatusFailure(output, latestStatusOutput, 'PTY timeout'),
          status: 'error'
        })
      }
    }, PTY_TIMEOUT_MS)

    const onDataDisposable = term.onData((data) => {
      output = appendDiagnosticOutput(output, data)
      latestStatusOutput = appendDiagnosticOutput(latestStatusOutput, data)

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
      // Why: pending-refresh and limit detection must both survive styled TUI output.
      const clean = sentStatus ? stripCodexPtyControlSequences(output) : ''

      if (
        sentStatus &&
        statusAttempts < MAX_STATUS_ATTEMPTS &&
        STATUS_REFRESH_PENDING_RE.test(clean)
      ) {
        scheduleStatusRetry()
      }

      if (sentStatus && !settleTimer && hasCodexPtyRateLimit(clean)) {
        settleTimer = setTimeout(() => {
          settleTimer = null
          if (resolved) {
            return
          }
          resolved = true
          clearSettleTimers()
          cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
          // Re-strip after the settle delay so trailing chunks are included.
          const settledClean = stripCodexPtyControlSequences(output)
          const { session, weekly } = parseCodexPtyStatus(settledClean)
          resolve({
            provider: 'codex',
            session,
            weekly,
            updatedAt: Date.now(),
            error:
              session || weekly
                ? null
                : withMacTailscaleDnsHint('Failed to parse CLI output', settledClean),
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
      if (!resolved) {
        resolved = true
        clearSettleTimers()
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
              : describePtyStatusFailure(
                  output,
                  latestStatusOutput,
                  'CLI exited before status was available'
                ),
          status: session || weekly ? 'ok' : 'error'
        })
      }
    })
    if (onExitDisposable) {
      termDisposables.push(onExitDisposable)
    }
  })
}
