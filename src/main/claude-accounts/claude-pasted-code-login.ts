import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import type { HostAccountSignInChannel } from '../../shared/host-account-sign-in-types'
import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
import { isClaudeLocalSignInLink, prepareClaudeSignInBrowser } from './claude-sign-in-browser'

// Why 10 minutes: the same window as the desktop login; signing in on another device is slower.
const LOGIN_TIMEOUT_MS = 600_000
const MAX_SCAN_CHARS = 8_000
const CLAUDE_AUTHORIZE_HOSTS = new Set(['claude.com', 'claude.ai'])
const CLAUDE_SIGN_IN_CANCELLED_MESSAGE = 'Claude sign-in was cancelled.'
export const CLAUDE_PASTED_CODE_REJECTED_MESSAGE =
  'Claude did not accept that code. Start the sign-in again.'

type RunCommand = (
  args: string[],
  config: ClaudeCommandConfig,
  timeoutMs: number,
  options?: ClaudeCommandOptions
) => Promise<string>

/** The sign-in link Claude prints for a code pasted back, never its localhost-callback one. */
export function parseClaudePastedCodeSignInLink(output: string): string | null {
  const plain = stripAnsiEscapeSequences(output)
  // Why trailing whitespace: output arrives in chunks, and a cut link authenticates nothing.
  for (const match of plain.matchAll(/(https:\/\/\S+)\s/g)) {
    try {
      const url = new URL(match[1])
      if (
        CLAUDE_AUTHORIZE_HOSTS.has(url.hostname) &&
        url.searchParams.get('code') === 'true' &&
        url.searchParams.has('redirect_uri') &&
        !isClaudeLocalSignInLink(url.toString())
      ) {
        return url.toString()
      }
    } catch {
      // Not a link; keep scanning.
    }
  }
  return null
}

/**
 * Runs `claude auth login` on this host for a person on another device: its printed link goes to
 * `channel`, and the code that page shows comes back through `channel` to Claude's stdin.
 */
export async function runClaudePastedCodeLogin(
  folder: ClaudeCommandConfig,
  runCommand: RunCommand,
  channel: HostAccountSignInChannel,
  setCancel: (cancel: (() => boolean) | null) => void
): Promise<void> {
  // Why before spawning: a flow cancelled while queued behind another account action runs nothing.
  if (channel.signal.aborted) {
    throw new Error(CLAUDE_SIGN_IN_CANCELLED_MESSAGE)
  }
  const controller = new AbortController()
  const abort = (): boolean => {
    if (controller.signal.aborted) {
      return false
    }
    controller.abort()
    return true
  }
  setCancel(abort)
  channel.signal.addEventListener('abort', abort, { once: true })
  let scanned = ''
  let prompted = false
  let sendToClaude: ((text: string) => void) | null = null
  let codeSent = false
  let browser: Awaited<ReturnType<typeof prepareClaudeSignInBrowser>> | null = null
  try {
    // Why a stand-in BROWSER: Claude must not open a browser on this host, which nobody is watching.
    browser = await prepareClaudeSignInBrowser(folder)
    await runCommand(['auth', 'login', '--claudeai'], folder, LOGIN_TIMEOUT_MS, {
      signal: controller.signal,
      keepStdinOpen: true,
      browser: browser.path,
      onStdin: (send) => {
        sendToClaude = send
      },
      onStdout: (text) => {
        if (prompted) {
          return
        }
        scanned = `${scanned}${text}`.slice(-MAX_SCAN_CHARS)
        const url = parseClaudePastedCodeSignInLink(scanned)
        if (!url) {
          return
        }
        prompted = true
        channel.onPrompt({ url, userCode: null, needsCode: true })
        void channel.nextCode().then(
          (code) => {
            codeSent = true
            sendToClaude?.(`${code}\n`)
          },
          () => {}
        )
      }
    })
  } catch (error) {
    // Why: Claude's own words for a bad code are an HTTP status, which says nothing to a person.
    // Only its own exit counts; a timeout or denial keeps its message.
    const exited = error instanceof Error && /^Claude command (failed|exited)/.test(error.message)
    throw codeSent && exited && !controller.signal.aborted
      ? new Error(CLAUDE_PASTED_CODE_REJECTED_MESSAGE, { cause: error })
      : error
  } finally {
    channel.signal.removeEventListener('abort', abort)
    setCancel(null)
    await browser?.dispose().catch((error: unknown) => {
      console.warn('[claude-accounts] Could not remove the Claude sign-in browser:', error)
    })
  }
}
