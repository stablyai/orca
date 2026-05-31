/* eslint-disable max-lines -- Why: Claude PTY usage scraping keeps prompt
driving, parser, timers, and teardown in one state machine; splitting it would
make the lifecycle harder to audit. */
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { resolveClaudeCommand } from '../codex-cli/command'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { cleanupHiddenRateLimitPty } from './hidden-pty-cleanup'

const PTY_TIMEOUT_MS = 25_000
const MAX_OUTPUT_LENGTH = 100_000 // 100KB buffer limit

// ---------------------------------------------------------------------------
// PTY fallback — spawn interactive `claude`, send `/usage`, parse the TUI
// ---------------------------------------------------------------------------

// Why: these patterns match the Claude CLI's /usage TUI panel output.
// "Current session" shows a percent like "62% used" or "62% left".
// "Current week" section is similar.
const SESSION_RE = /current\s*session/i
const WEEKLY_RE = /current\s*week/i
const PERCENT_RE = /(\d{1,3})(?:\.\d+)?\s*%\s*(used|left|remaining|available)/i
const RESET_LINE_RE = /resets?\s+(?:at\s+|in\s+)?(.+)/i
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const OSC_SEQUENCE_RE = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, 'g')
const CSI_SEQUENCE_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

function stripTerminalControlSequences(output: string): string {
  return output.replace(OSC_SEQUENCE_RE, '').replace(CSI_SEQUENCE_RE, '')
}

/**
 * Extract percent-left from lines following a label match.
 * Scans up to 12 lines after the label to find the associated percent.
 */
function extractPercentAfterLabel(lines: string[], labelRe: RegExp): number | null {
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) {
      continue
    }
    // Scan next 12 lines for a percent
    for (let j = i; j < Math.min(i + 12, lines.length); j++) {
      const m = PERCENT_RE.exec(lines[j])
      if (m) {
        const pct = parseFloat(m[1])
        const word = m[2].toLowerCase()
        const isUsed = word === 'used'
        return isUsed ? pct : 100 - pct
      }
    }
  }
  return null
}

function extractResetAfterLabel(lines: string[], labelRe: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) {
      continue
    }
    for (let j = i; j < Math.min(i + 14, lines.length); j++) {
      const m = RESET_LINE_RE.exec(lines[j])
      if (m) {
        return m[1].trim().replace(/[)]+$/, '')
      }
    }
  }
  return null
}

function parsePtyUsage(output: string): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
} {
  const lines = output.split(/\r\n|\n|\r/)

  const sessionPct = extractPercentAfterLabel(lines, SESSION_RE)
  const weeklyPct = extractPercentAfterLabel(lines, WEEKLY_RE)

  const session: RateLimitWindow | null =
    sessionPct !== null
      ? {
          usedPercent: Math.min(100, Math.max(0, sessionPct)),
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: extractResetAfterLabel(lines, SESSION_RE)
        }
      : null

  const weekly: RateLimitWindow | null =
    weeklyPct !== null
      ? {
          usedPercent: Math.min(100, Math.max(0, weeklyPct)),
          windowMinutes: 10080,
          resetsAt: null,
          resetDescription: extractResetAfterLabel(lines, WEEKLY_RE)
        }
      : null

  return { session, weekly }
}

// Why: these substrings indicate the /usage TUI panel has finished
// rendering. We stop collecting output once one appears, then allow
// a settle period for the rest of the content to flush.
const STOP_SUBSTRINGS = [
  'Current week (all models)',
  'Current week (Opus)',
  'Current week (Sonnet only)',
  'Current week (Sonnet)',
  'Current session',
  'Failed to load usage data',
  'failed to load usage data'
]

// Why: prompt detection is unreliable because the Claude CLI v2.x renders
// a status bar and TUI elements that push the `❯` prompt out of any
// reasonable detection window. Instead we wait a fixed 2s after spawning
// for the CLI to initialize, then send `/usage\r` directly. Command
// palette prompts ("Show plan usage limits") are auto-confirmed with Enter.
const COMMAND_PALETTE_RE = /show plan|usage limits/i
const TRUST_PROMPT_RE = /do you trust|trust the files|safety check/i
const RATE_LIMITED_RE = /rate limited\.?\s+please try again later/i
const LOAD_FAILED_RE = /failed to load usage data/i
const CLAUDE_21_USAGE_TABS_RE = /settings?\s+status?\s+config\s+usage\s+stats/i
const CLAUDE_21_SESSION_STATS_RE = /total\s*cost|total\s*duration|usage:\s*\d+\s*input/i
const STARTUP_DELAY_MS = 2_000
const SETTLE_AFTER_STOP_MS = 2_000
const SETTLE_AFTER_CLAUDE_21_USAGE_MS = 8_000

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function describeClaudeUsageFailure(output: string): string {
  if (RATE_LIMITED_RE.test(output)) {
    return 'Claude usage is rate limited right now.'
  }

  if (LOAD_FAILED_RE.test(output)) {
    return 'Claude usage is unavailable right now.'
  }

  if (CLAUDE_21_USAGE_TABS_RE.test(output) || CLAUDE_21_SESSION_STATS_RE.test(output)) {
    return 'Claude plan usage is unavailable for this Claude CLI session.'
  }

  // Why: parser failures are an implementation detail of Orca's PTY fallback.
  // The UI should explain the user-visible outcome, not leak internal parsing
  // mechanics that the user cannot act on.
  return 'Claude usage is unavailable right now.'
}

export async function fetchViaPty(options?: {
  authPreparation?: ClaudeRuntimeAuthPreparation
}): Promise<ProviderRateLimits> {
  const pty = await import('node-pty')

  return new Promise<ProviderRateLimits>((resolve) => {
    let output = ''
    let resolved = false
    let sentUsage = false
    let stopDetected = false
    let claude21UsageDetected = false
    let claude21UsageSettleTimer: ReturnType<typeof setTimeout> | null = null

    const claudeCommand = resolveClaudeCommand()

    // Why: node-pty cannot spawn .cmd/.bat batch scripts directly on Windows —
    // those need cmd.exe as an interpreter. Always route through cmd.exe on win32
    // and ensure the command path is properly quoted if it contains spaces.
    const isWin32 = process.platform === 'win32'
    const spawnEnv = applyClaudeEnvPatch(
      { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      options?.authPreparation?.envPatch ?? {},
      { stripAuthEnv: options?.authPreparation?.stripAuthEnv ?? false }
    )
    const authPreparation = options?.authPreparation
    const wslConfig =
      authPreparation?.runtime === 'wsl' &&
      authPreparation.wslDistro &&
      authPreparation.wslLinuxConfigDir
        ? {
            distro: authPreparation.wslDistro,
            linuxConfigDir: authPreparation.wslLinuxConfigDir
          }
        : null
    const spawnFile = wslConfig ? 'wsl.exe' : isWin32 ? 'cmd.exe' : claudeCommand
    const spawnArgs = wslConfig
      ? [
          '-d',
          wslConfig.distro,
          '--',
          'bash',
          '-lc',
          `export CLAUDE_CONFIG_DIR=${shellQuote(wslConfig.linuxConfigDir)}; exec claude`
        ]
      : isWin32
        ? ['/c', `"${claudeCommand}"`]
        : []

    const term = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      env: spawnEnv
    })
    const termDisposables: { dispose: () => void }[] = []

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        if (claude21UsageSettleTimer) {
          clearTimeout(claude21UsageSettleTimer)
          claude21UsageSettleTimer = null
        }
        if (enterInterval) {
          clearInterval(enterInterval)
          enterInterval = null
        }
        cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
        // Even on timeout, try to parse whatever we collected
        const clean = stripTerminalControlSequences(output)
        const { session, weekly } = parsePtyUsage(clean)
        if (session || weekly) {
          resolve({
            provider: 'claude',
            session,
            weekly,
            updatedAt: Date.now(),
            error: null,
            status: 'ok'
          })
        } else {
          resolve({
            provider: 'claude',
            session: null,
            weekly: null,
            updatedAt: Date.now(),
            error: withMacTailscaleDnsHint(
              CLAUDE_21_USAGE_TABS_RE.test(clean) || CLAUDE_21_SESSION_STATS_RE.test(clean)
                ? describeClaudeUsageFailure(clean)
                : 'PTY timeout — /usage panel did not render',
              clean
            ),
            status: 'error'
          })
        }
      }
    }, PTY_TIMEOUT_MS)

    // Why: the Claude TUI may have scrollable panels or prompts.
    // Sending Enter every 0.8s advances through them.
    let enterInterval: ReturnType<typeof setInterval> | null = null

    function startEnterPresses(): void {
      if (enterInterval) {
        return
      }
      enterInterval = setInterval(() => {
        if (!resolved && !stopDetected) {
          term.write('\r')
        }
      }, 800)
    }

    function finalize(): void {
      if (resolved) {
        return
      }
      resolved = true
      clearTimeout(timeout)
      if (claude21UsageSettleTimer) {
        clearTimeout(claude21UsageSettleTimer)
        claude21UsageSettleTimer = null
      }
      if (enterInterval) {
        clearInterval(enterInterval)
      }
      cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })

      const clean = stripTerminalControlSequences(output)
      const { session, weekly } = parsePtyUsage(clean)

      if (!session && !weekly) {
        resolve({
          provider: 'claude',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: withMacTailscaleDnsHint(describeClaudeUsageFailure(clean), clean),
          status: 'error'
        })
      } else {
        resolve({
          provider: 'claude',
          session,
          weekly,
          updatedAt: Date.now(),
          error: null,
          status: 'ok'
        })
      }
    }

    // Why: wait 2s for the CLI to initialize, then send `/usage\r`
    // directly without detecting the prompt character (see comment above).
    setTimeout(() => {
      if (resolved) {
        return
      }
      sentUsage = true
      term.write('/usage\r')
      startEnterPresses()
    }, STARTUP_DELAY_MS)

    const onDataDisposable = term.onData((data) => {
      output += data
      // Why: prevent memory exhaustion if the CLI process floods output
      if (output.length > MAX_OUTPUT_LENGTH) {
        output = output.slice(-MAX_OUTPUT_LENGTH)
      }

      const cleanChunk = stripTerminalControlSequences(data)

      // Why: the Claude CLI may prompt for first-run setup (trust files,
      // workspace directory). Auto-accept so we can reach /usage.
      if (TRUST_PROMPT_RE.test(cleanChunk)) {
        term.write('y\r')
        return
      }

      // Why: Claude CLI v2.x may show a command palette when `/usage` is
      // entered, listing options like "Show plan usage limits". Auto-confirm
      // by sending Enter when these prompts appear.
      if (sentUsage && COMMAND_PALETTE_RE.test(cleanChunk)) {
        term.write('\r')
      }

      // Check if we've hit a stop substring indicating the panel rendered
      if (sentUsage && !stopDetected) {
        const clean = stripTerminalControlSequences(output)
        if (
          !claude21UsageDetected &&
          (CLAUDE_21_USAGE_TABS_RE.test(clean) || CLAUDE_21_SESSION_STATS_RE.test(clean))
        ) {
          claude21UsageDetected = true
          if (enterInterval) {
            clearInterval(enterInterval)
            enterInterval = null
          }
          // Why: Claude 2.1 may render session stats without subscription
          // plan windows. Give async usage loading a grace period, then finish
          // with a user-facing unavailable state instead of a false PTY timeout.
          claude21UsageSettleTimer = setTimeout(finalize, SETTLE_AFTER_CLAUDE_21_USAGE_MS)
        }
        for (const sub of STOP_SUBSTRINGS) {
          if (clean.includes(sub)) {
            stopDetected = true
            // Why: 2.0s settle time after detecting the stop substring
            // allows the full panel to finish rendering.
            setTimeout(finalize, SETTLE_AFTER_STOP_MS)
            break
          }
        }
      }
    })
    if (onDataDisposable) {
      termDisposables.push(onDataDisposable)
    }

    const onExitDisposable = term.onExit(() => {
      cleanupHiddenRateLimitPty(term, termDisposables, { kill: false })
      if (claude21UsageSettleTimer) {
        clearTimeout(claude21UsageSettleTimer)
        claude21UsageSettleTimer = null
      }
      if (enterInterval) {
        clearInterval(enterInterval)
        enterInterval = null
      }
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        const clean = stripTerminalControlSequences(output)
        const { session, weekly } = parsePtyUsage(clean)
        resolve({
          provider: 'claude',
          session,
          weekly,
          updatedAt: Date.now(),
          error:
            session || weekly
              ? null
              : withMacTailscaleDnsHint('CLI exited before /usage rendered', clean),
          status: session || weekly ? 'ok' : 'error'
        })
      }
    })
    if (onExitDisposable) {
      termDisposables.push(onExitDisposable)
    }
  })
}
