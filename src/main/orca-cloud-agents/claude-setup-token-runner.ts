// Runs the unmodified `claude setup-token` on this computer (spec §5 state 6) and reads the
// long-lived token it prints. The token stays in this module's caller: it is never logged, never put
// in an error, and never returned to the renderer. Output is scanned in memory and dropped.
import { CLAUDE_SETUP_TOKEN_PATTERN } from '../../shared/orca-cloud-agents/orca-cloud-agents-wire'

/** The child, as the runner needs it. Production is a pseudo-terminal (Claude's UI needs a TTY). */
export type SetupTokenProcess = {
  onData(listener: (chunk: string) => void): void
  onExit(listener: (exitCode: number | null) => void): void
  kill(): void
}

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
// Terminal escapes become a separator, so a styled word right after the token can't extend it.
const TERMINAL_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g
const TOKEN_CANDIDATE = /sk-ant-oat01-[A-Za-z0-9_-]+/g
const TOKEN_CHAR = /[A-Za-z0-9_-]/
const DENIED =
  /\baccess_denied\b|authorization (?:request )?(?:was )?denied|sign-?in (?:was )?denied|login (?:was )?denied/i
const AUTHORIZE_HOSTS = new Set(['claude.ai', 'claude.com', 'console.anthropic.com'])
const LINK = /https:\/\/[^\s"'<>]+(?=\s)/g

function plainText(raw: string): string {
  return raw.replace(TERMINAL_ESCAPE, '\n')
}

/**
 * The setup-token in `text`, once it is complete: followed by a non-token character, or at the end
 * when `final` (the process exited). Exported for tests; callers never log its result.
 */
export function findSetupToken(text: string, final: boolean): string | null {
  const plain = plainText(text)
  let found: string | null = null
  for (const match of plain.matchAll(TOKEN_CANDIDATE)) {
    const end = (match.index ?? 0) + match[0].length
    const terminated = end < plain.length && !TOKEN_CHAR.test(plain[end])
    if ((terminated || final) && CLAUDE_SETUP_TOKEN_PATTERN.test(match[0])) {
      // The last complete one wins: a redraw repeats the same token.
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
}): Promise<ClaudeSetupTokenOutcome> {
  const { spawn, signal, onAuthorizeUrl } = options
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
    let timer: ReturnType<typeof setTimeout> | null = null
    let graceTimer: ReturnType<typeof setTimeout> | null = null

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
      signal.removeEventListener('abort', onAbort)
      // Nothing of the output outlives the run.
      scanned = ''
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
          const token = findSetupToken(scanned, false)
          if (token) {
            finish({ ok: true, token }, 'grace')
            return
          }
          if (DENIED.test(plainText(scanned))) {
            finish({ ok: false, error: 'denied' }, 'kill')
            return
          }
          if (!linkSeen) {
            const url = findAuthorizeUrl(scanned)
            if (url) {
              linkSeen = true
              onAuthorizeUrl?.(url)
            }
          }
        })
        process.onExit(() => {
          exited = true
          if (graceTimer) {
            clearTimeout(graceTimer)
          }
          const token = settled ? null : findSetupToken(scanned, true)
          finish(token ? { ok: true, token } : { ok: false, error: 'capture_failed' }, 'none')
        })
      },
      (error: unknown) => {
        const missing =
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === 'ENOENT'
        finish({ ok: false, error: missing ? 'no_cli' : 'capture_failed' }, 'none')
      }
    )
  })
}
