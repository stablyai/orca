/* eslint-disable max-lines -- Why: Claude PTY usage scraping keeps prompt
driving, parser, timers, and teardown in one state machine; splitting it would
make the lifecycle harder to audit. */
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { buildConfiguredProxyEnv, type NetworkProxySettings } from '../../shared/network-proxy'
import { resolveClaudeCommand } from '../codex-cli/command'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { cleanupHiddenRateLimitPty, registerHiddenRateLimitPty } from './hidden-pty-cleanup'
import { extractClaudePtyResetMetadata } from './claude-pty-reset-parser'
import {
  getHiddenRateLimitWslCwdSetupCommands,
  resolveHiddenRateLimitPtyCwd
} from './hidden-rate-limit-pty-cwd'

const PTY_TIMEOUT_MS = 25_000
const MAX_OUTPUT_LENGTH = 100_000 // 100KB buffer limit

// ---------------------------------------------------------------------------
// PTY fallback — spawn interactive `claude`, send `/usage`, parse the TUI
// ---------------------------------------------------------------------------

// Why: these patterns match the Claude CLI's /usage TUI panel output.
// "Current session" shows a percent like "62% used" or "62% left".
// Weekly labels have varied between "Current week" and "Weekly limits".
const SESSION_RE = /current\s*session/i
const WEEKLY_RE = /(?:current\s*week|weekly\s*(?:limits?|usage|rate\s*limits?)|7\s*[- ]?\s*day)/i
const FABLE_WORD_RE = /\bfable\b/i
const FABLE_LABEL_RE = /^\s*fable\s*$/i
// Why: derive from WEEKLY_RE so a future weekly-wording change stays in one place
// instead of silently reopening the Fable-weekly parsing gap this fix closed.
const FABLE_WEEKLY_LABEL_RE = new RegExp(
  `${WEEKLY_RE.source}\\s*(?:\\([^)]*\\bfable\\b[^)]*\\)|[-:]?\\s*\\bfable\\b)`,
  'i'
)
const PERCENT_RE = /(\d{1,3})(?:\.\d+)?\s*%\s*(used|consumed|left|remaining|available)/i
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
function matchesWeeklyLabel(line: string): boolean {
  return WEEKLY_RE.test(line) && !FABLE_WORD_RE.test(line)
}

function matchesFableBoundary(line: string): boolean {
  return FABLE_LABEL_RE.test(line) || (FABLE_WORD_RE.test(line) && WEEKLY_RE.test(line))
}

function matchesFableUsageLabel(line: string): boolean {
  // Why: broad Fable-weekly copy should stop nearby scans, but only a real
  // Fable usage heading should produce the distinct Fable meter.
  return FABLE_LABEL_RE.test(line) || FABLE_WEEKLY_LABEL_RE.test(line)
}

function isSectionLabel(line: string): boolean {
  return SESSION_RE.test(line) || matchesWeeklyLabel(line) || matchesFableBoundary(line)
}

function extractPercentAfterLabel(
  lines: string[],
  matchesLabel: (line: string) => boolean
): number | null {
  for (let i = 0; i < lines.length; i++) {
    if (!matchesLabel(lines[i])) {
      continue
    }
    // Scan next 12 lines for a percent
    for (let j = i; j < Math.min(i + 12, lines.length); j++) {
      if (j > i && isSectionLabel(lines[j])) {
        break
      }
      const m = PERCENT_RE.exec(lines[j])
      if (m) {
        const pct = Number.parseFloat(m[1])
        const word = m[2].toLowerCase()
        const isUsed = word === 'used' || word === 'consumed'
        return isUsed ? pct : 100 - pct
      }
    }
  }
  return null
}

function parsePtyUsage(output: string): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  fableWeekly: RateLimitWindow | null
} {
  const lines = output.split(/\r\n|\n|\r/)

  const sessionPct = extractPercentAfterLabel(lines, (line) => SESSION_RE.test(line))
  const weeklyPct = extractPercentAfterLabel(lines, matchesWeeklyLabel)
  const fableWeeklyPct = extractPercentAfterLabel(lines, matchesFableUsageLabel)
  const sessionReset = extractClaudePtyResetMetadata(
    lines,
    (line) => SESSION_RE.test(line),
    isSectionLabel
  )
  const weeklyReset = extractClaudePtyResetMetadata(lines, matchesWeeklyLabel, isSectionLabel)
  const fableWeeklyReset = extractClaudePtyResetMetadata(
    lines,
    matchesFableUsageLabel,
    isSectionLabel
  )

  const session: RateLimitWindow | null =
    sessionPct !== null
      ? {
          usedPercent: Math.min(100, Math.max(0, sessionPct)),
          windowMinutes: 300,
          resetsAt: sessionReset.resetsAt,
          resetDescription: sessionReset.resetDescription
        }
      : null

  const weekly: RateLimitWindow | null =
    weeklyPct !== null
      ? {
          usedPercent: Math.min(100, Math.max(0, weeklyPct)),
          windowMinutes: 10080,
          resetsAt: weeklyReset.resetsAt,
          resetDescription: weeklyReset.resetDescription
        }
      : null

  const fableWeekly: RateLimitWindow | null =
    fableWeeklyPct !== null
      ? {
          usedPercent: Math.min(100, Math.max(0, fableWeeklyPct)),
          windowMinutes: 10080,
          resetsAt: fableWeeklyReset.resetsAt,
          resetDescription: fableWeeklyReset.resetDescription
        }
      : null

  return { session, weekly, fableWeekly }
}

// Why: these substrings indicate the /usage TUI panel has finished
// rendering. We stop collecting output once one appears, then allow
// a settle period for the rest of the content to flush.
const STOP_SUBSTRINGS = [
  'Current week (all models)',
  'Current week (Opus)',
  'Current week (Sonnet only)',
  'Current week (Sonnet)',
  'Weekly limits',
  'Weekly limit',
  'Weekly usage',
  '7-day',
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

function abortedClaudeUsageResult(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Rate-limit fetch aborted',
    status: 'error'
  }
}

export async function fetchViaPty(options?: {
  authPreparation?: ClaudeRuntimeAuthPreparation
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedClaudeUsageResult()
  }
  const pty = await import('node-pty')
  if (options?.signal?.aborted) {
    return abortedClaudeUsageResult()
  }

  return new Promise<ProviderRateLimits>((resolve) => {
    let output = ''
    let resolved = false
    let sentUsage = false
    let stopDetected = false
    let claude21UsageDetected = false
    let startupDelayTimer: ReturnType<typeof setTimeout> | null = null
    let stopSettleTimer: ReturnType<typeof setTimeout> | null = null
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
    // Why: this hidden usage PTY spawns `claude` directly, not the user's shell
    // wrapper, so without the configured proxy it would reach api.anthropic.com
    // from the app's own IP — bypassing the proxy the user set for Claude and
    // risking rate-limit/geo signals on the account. Falls back to {} when unset.
    const proxyEnv = buildConfiguredProxyEnv(options?.networkProxySettings)
    Object.assign(spawnEnv, proxyEnv)
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
          // Why: Windows-side env does not cross into the distro without WSLENV,
          // so export the configured proxy inside the command for the inner claude.
          [
            // Why: hidden usage probes must not inherit a root-like WSL cwd;
            // keep Claude discovery bounded to a tiny temp directory.
            ...getHiddenRateLimitWslCwdSetupCommands(),
            `export CLAUDE_CONFIG_DIR=${shellQuote(wslConfig.linuxConfigDir)}`,
            ...Object.entries(proxyEnv).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
            'exec claude'
          ].join(' && ')
        ]
      : isWin32
        ? ['/c', `"${claudeCommand}"`]
        : []

    const term = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      // Why: hidden usage PTYs must not inherit the process cwd (e.g. / or a
      // drive root), which can trigger unbounded file discovery.
      cwd: resolveHiddenRateLimitPtyCwd(),
      env: spawnEnv
    })
    const termDisposables: { dispose: () => void }[] = [registerHiddenRateLimitPty(term)]
    let enterInterval: ReturnType<typeof setInterval> | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    function clearFollowupTimers(): void {
      if (startupDelayTimer) {
        clearTimeout(startupDelayTimer)
        startupDelayTimer = null
      }
      if (stopSettleTimer) {
        clearTimeout(stopSettleTimer)
        stopSettleTimer = null
      }
      if (claude21UsageSettleTimer) {
        clearTimeout(claude21UsageSettleTimer)
        claude21UsageSettleTimer = null
      }
      if (enterInterval) {
        clearInterval(enterInterval)
        enterInterval = null
      }
    }

    function settleAborted(): void {
      if (resolved) {
        return
      }
      resolved = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      clearFollowupTimers()
      cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
      resolve(abortedClaudeUsageResult())
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
        clearFollowupTimers()
        cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })
        // Even on timeout, try to parse whatever we collected
        const clean = stripTerminalControlSequences(output)
        const { session, weekly, fableWeekly } = parsePtyUsage(clean)
        if (session || weekly || fableWeekly) {
          resolve({
            provider: 'claude',
            session,
            weekly,
            fableWeekly,
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
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      clearFollowupTimers()
      cleanupHiddenRateLimitPty(term, termDisposables, { kill: true })

      const clean = stripTerminalControlSequences(output)
      const { session, weekly, fableWeekly } = parsePtyUsage(clean)

      if (!session && !weekly && !fableWeekly) {
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
          fableWeekly,
          updatedAt: Date.now(),
          error: null,
          status: 'ok'
        })
      }
    }

    // Why: wait 2s for the CLI to initialize, then send `/usage\r`
    // directly without detecting the prompt character (see comment above).
    startupDelayTimer = setTimeout(() => {
      startupDelayTimer = null
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
            stopSettleTimer = setTimeout(finalize, SETTLE_AFTER_STOP_MS)
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
      clearFollowupTimers()
      if (!resolved) {
        resolved = true
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        const clean = stripTerminalControlSequences(output)
        const { session, weekly, fableWeekly } = parsePtyUsage(clean)
        resolve({
          provider: 'claude',
          session,
          weekly,
          fableWeekly,
          updatedAt: Date.now(),
          error:
            session || weekly || fableWeekly
              ? null
              : withMacTailscaleDnsHint('CLI exited before /usage rendered', clean),
          status: session || weekly || fableWeekly ? 'ok' : 'error'
        })
      }
    })
    if (onExitDisposable) {
      termDisposables.push(onExitDisposable)
    }
  })
}
