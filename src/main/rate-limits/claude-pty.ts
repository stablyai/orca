import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { buildConfiguredProxyEnv, type NetworkProxySettings } from '../../shared/network-proxy'
import { resolveClaudeCommand } from '../codex-cli/command'
// Why: import from the shared module, not the codex-cli re-export, so a test that
// mocks '../codex-cli/command' does not have to restate this pure helper.
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { cleanupHiddenRateLimitPty, registerHiddenRateLimitPty } from './hidden-pty-cleanup'
import {
  getHiddenRateLimitWslCwdSetupCommands,
  resolveHiddenRateLimitPtyCwd
} from './hidden-rate-limit-pty-cwd'
import {
  abortedClaudeUsageResult,
  describeClaudeUsageFailure,
  isClaude21UsagePanel,
  parseClaudePtyUsage,
  stripTerminalControlSequences
} from './claude-pty-usage-parser'
import { quoteHiddenRateLimitShellValue } from './hidden-rate-limit-shell'
import { CLAUDE_USAGE_STOP_SUBSTRINGS } from './claude-pty-stop-markers'

const PTY_TIMEOUT_MS = 25_000
const MAX_OUTPUT_LENGTH = 100_000 // 100KB buffer limit

// ---------------------------------------------------------------------------
// PTY fallback — spawn interactive `claude`, send `/usage`, parse the TUI
// ---------------------------------------------------------------------------

// Why: prompt detection is unreliable because the Claude CLI v2.x renders
// a status bar and TUI elements that push the `❯` prompt out of any
// reasonable detection window. Instead we wait a fixed 2s after spawning
// for the CLI to initialize, then send `/usage\r` directly. Command
// palette prompts ("Show plan usage limits") are auto-confirmed with Enter.
const COMMAND_PALETTE_RE = /show plan|usage limits/i
const TRUST_PROMPT_RE = /do you trust|trust the files|safety check/i
const STARTUP_DELAY_MS = 2_000
const SETTLE_AFTER_STOP_MS = 2_000
const SETTLE_AFTER_CLAUDE_21_USAGE_MS = 8_000

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
          '--exec',
          'bash',
          '-lc',
          // Why: Windows-side env does not cross into the distro without WSLENV,
          // so export the configured proxy inside the command for the inner claude.
          [
            // Why: hidden usage probes must not inherit a root-like WSL cwd;
            // keep Claude discovery bounded to a tiny temp directory.
            ...getHiddenRateLimitWslCwdSetupCommands(),
            `export CLAUDE_CONFIG_DIR=${quoteHiddenRateLimitShellValue(wslConfig.linuxConfigDir)}`,
            ...Object.entries(proxyEnv).map(
              ([key, value]) => `export ${key}=${quoteHiddenRateLimitShellValue(value)}`
            ),
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
      env: withCliRuntimeOnPath(claudeCommand, spawnEnv)
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
        const { session, weekly, fableWeekly } = parseClaudePtyUsage(clean)
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
              isClaude21UsagePanel(clean)
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
      const { session, weekly, fableWeekly } = parseClaudePtyUsage(clean)

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
        if (!claude21UsageDetected && isClaude21UsagePanel(clean)) {
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
        for (const sub of CLAUDE_USAGE_STOP_SUBSTRINGS) {
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
        const { session, weekly, fableWeekly } = parseClaudePtyUsage(clean)
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
