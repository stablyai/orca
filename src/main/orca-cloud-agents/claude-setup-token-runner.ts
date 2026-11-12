// Runs the unmodified `claude setup-token` on this computer (spec §5 state 6) and reads the
// long-lived token it prints. The token stays in this module's caller: it is never logged, never put
// in an error, and never returned to the renderer. Output is scanned in memory and dropped.
import { CLAUDE_SETUP_TOKEN_PATTERN } from '../../shared/orca-cloud-agents/orca-cloud-agents-wire'

/** The child, as the runner needs it. Production is a pseudo-terminal (Claude's UI needs a TTY). */
export type SetupTokenProcess = {
  onData(listener: (chunk: string) => void): void
  onExit(listener: (exitCode: number | null) => void): void
  kill(): void
  /** Types into the CLI, like a user at its prompt (the pasted sign-in code). */
  write(data: string): void
}

/** Hands the CLI the code from Claude's "Paste this into Claude Code" page. False when it can't take one now. */
export type SubmitSetupCode = (code: string) => boolean

/** Rejects with `{ code: 'ENOENT' }` when there is no `claude` to run. */
export type SpawnSetupToken = () => Promise<SetupTokenProcess>

export type ClaudeSetupTokenFailure =
  | 'no_cli'
  | 'denied'
  | 'timed_out'
  | 'capture_failed'
  | 'cancelled'

export type ClaudeSetupTokenOutcome =
  | { ok: true; token: string }
  | { ok: false; error: ClaudeSetupTokenFailure }

// Setup-token waits for a browser approval, like `claude auth login`.
const DEFAULT_TIMEOUT_MS = 600_000
// Output is kept only as long as a token or a link could span chunks.
const MAX_SCAN_CHARS = 16_000
// After the token prints, setup-token exits on its own; this is the backstop.
const EXIT_GRACE_MS = 3_000
// Redraws can repeat the token; the longest complete copy seen in this window wins.
const SETTLE_MS = 1_000
// Styling and cursor show/hide never break a line, so they vanish; every other terminal escape
// (cursor moves, erases) and control character becomes a line break, so text from another spot on
// the screen can't extend the token.
// eslint-disable-next-line no-control-regex
const INLINE_ESCAPE = /\u001b\[[0-9;:?]*[mhl]/g
const TERMINAL_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g
const TOKEN_CANDIDATE = /sk-ant-oat01-[A-Za-z0-9_-]+/g
const TOKEN_CHAR = /[A-Za-z0-9_-]/
const DENIED =
  /\baccess_denied\b|authorization (?:request )?(?:was )?denied|sign-?in (?:was )?denied|login (?:was )?denied/i
const AUTHORIZE_HOSTS = new Set(['claude.ai', 'claude.com', 'console.anthropic.com'])
const LINK = /https:\/\/[^\s"'<>]+(?=\s)/g
// The CLI's answer to a pasted code it could not exchange; it then waits for Enter to start over.
const CODE_REJECTED = /code wasn.t accepted|Invalid authorization code|OAuth error/i
// Ink reads a chunk ending in Enter as a paste; the code and the Enter go in separately.
const ENTER_AFTER_CODE_MS = 150
// Long enough to read the rejection; then Enter starts a fresh sign-in (new link, new code).
const RETRY_AFTER_REJECT_MS = 500

function plainText(raw: string): string {
  return raw.replace(INLINE_ESCAPE, '').replace(TERMINAL_ESCAPE, '\n')
}

/**
 * The setup-token in `text`, once complete: followed by a non-token character, or at the end when
 * `final` (the process exited). With several copies (a redraw), the longest wins, so a copy cut by
 * a repaint never beats the whole one. Exported for tests; callers never log its result.
 */
export function findSetupToken(text: string, final: boolean): string | null {
  const plain = plainText(text)
  let found: string | null = null
  for (const match of plain.matchAll(TOKEN_CANDIDATE)) {
    const end = (match.index ?? 0) + match[0].length
    const terminated = end < plain.length && !TOKEN_CHAR.test(plain[end])
    if (
      (terminated || final) &&
      CLAUDE_SETUP_TOKEN_PATTERN.test(match[0]) &&
      match[0].length > (found?.length ?? 0)
    ) {
      found = match[0]
    }
  }
  return found
}

/** Claude's sign-in page, for "Open again". Only its own OAuth hosts. */
export function findAuthorizeUrl(text: string): string | null {
  for (const match of plainText(text).matchAll(LINK)) {
    try {
      const url = new URL(match[0])
      if (AUTHORIZE_HOSTS.has(url.hostname) && url.pathname.includes('oauth')) {
        return url.toString()
      }
    } catch {
      // Not a link; keep scanning.
    }
  }
  return null
}

export function runClaudeSetupToken(options: {
  spawn: SpawnSetupToken
  signal: AbortSignal
  timeoutMs?: number
  onAuthorizeUrl?: (url: string) => void
  /** The CLI is waiting at its sign-in prompt: from here a pasted code can finish it. */
  onAcceptsCode?: (submit: SubmitSetupCode) => void
  /** The CLI refused the pasted code and started over; a new link (onAuthorizeUrl) follows. */
  onCodeRejected?: () => void
}): Promise<ClaudeSetupTokenOutcome> {
  const { spawn, signal, onAuthorizeUrl, onAcceptsCode, onCodeRejected } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ ok: false, error: 'cancelled' })
      return
    }
    let child: SetupTokenProcess | null = null
    let settled = false
    let exited = false
    let scanned = ''
    let linkSeen = false
    // A code was typed in and the CLI hasn't answered yet (token, or a rejection).
    let codePending = false
    let best: string | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let graceTimer: ReturnType<typeof setTimeout> | null = null
    const remember = (token: string | null): void => {
      if (token && token.length > (best?.length ?? 0)) {
        best = token
      }
    }

    const kill = (): void => {
      if (child && !exited) {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      }
    }
    const finish = (outcome: ClaudeSetupTokenOutcome, stop: 'kill' | 'grace' | 'none'): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (settleTimer) {
        clearTimeout(settleTimer)
      }
      signal.removeEventListener('abort', onAbort)
      // Nothing of the output outlives the run.
      scanned = ''
      best = null
      if (stop === 'kill') {
        kill()
      } else if (stop === 'grace' && !exited) {
        graceTimer = setTimeout(kill, EXIT_GRACE_MS)
        graceTimer.unref?.()
      }
      resolve(outcome)
    }
    function onAbort(): void {
      finish({ ok: false, error: 'cancelled' }, 'kill')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish({ ok: false, error: 'timed_out' }, 'kill'), timeoutMs)
    timer.unref?.()

    spawn().then(
      (process) => {
        child = process
        if (settled) {
          kill()
          return
        }
        process.onData((chunk) => {
          if (settled) {
            return
          }
          scanned = `${scanned}${chunk}`.slice(-MAX_SCAN_CHARS)
          remember(findSetupToken(scanned, false))
          if (best && !settleTimer) {
            settleTimer = setTimeout(() => {
              const token = best
              if (token) {
                finish({ ok: true, token }, 'grace')
              }
            }, SETTLE_MS)
            settleTimer.unref?.()
          }
          if (best) {
            return
          }
          if (DENIED.test(plainText(scanned))) {
            finish({ ok: false, error: 'denied' }, 'kill')
            return
          }
          if (codePending && CODE_REJECTED.test(plainText(scanned))) {
            // Start over in the same run: Enter gets a fresh link; the old code page is spent.
            codePending = false
            linkSeen = false
            scanned = ''
            onCodeRejected?.()
            const retry = setTimeout(() => {
              if (!settled && !exited) {
                process.write('\r')
              }
            }, RETRY_AFTER_REJECT_MS)
            retry.unref?.()
            return
          }
          if (!linkSeen) {
            const url = findAuthorizeUrl(scanned)
            if (url) {
              linkSeen = true
              onAuthorizeUrl?.(url)
              onAcceptsCode?.((code) => {
                if (settled || exited || !linkSeen || codePending) {
                  return false
                }
                codePending = true
                process.write(code)
                const enter = setTimeout(() => {
                  if (!settled && !exited) {
                    process.write('\r')
                  }
                }, ENTER_AFTER_CODE_MS)
                enter.unref?.()
                return true
              })
            }
          }
        })
        process.onExit(() => {
          exited = true
          if (graceTimer) {
            clearTimeout(graceTimer)
          }
          if (!settled) {
            remember(findSetupToken(scanned, true))
          }
          const token = best
          finish(token ? { ok: true, token } : { ok: false, error: 'capture_failed' }, 'none')
        })
      },
      (error: unknown) => {
        const missing =
          typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
        finish({ ok: false, error: missing ? 'no_cli' : 'capture_failed' }, 'none')
      }
    )
  })
}
