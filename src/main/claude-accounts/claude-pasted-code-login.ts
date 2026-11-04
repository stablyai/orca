import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import type { HostAccountSignInChannel } from '../../shared/host-account-sign-in-types'
import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
import { isClaudeLocalSignInLink, prepareClaudeSignInBrowser } from './claude-sign-in-browser'

// Match the desktop login window and allow time to sign in on another device.
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

export function parseClaudePastedCodeSignInLink(output: string): string | null {
  const plain = stripAnsiEscapeSequences(output)
  // Require trailing whitespace to avoid publishing a link truncated between chunks.
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

/** Relay the sign-in link and pasted code between a remote user and local Claude. */
export async function runClaudePastedCodeLogin(
  folder: ClaudeCommandConfig,
  runCommand: RunCommand,
  channel: HostAccountSignInChannel,
  setCancel: (cancel: (() => boolean) | null) => void
): Promise<void> {
  // Cancellation while queued must prevent spawning the login.
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
    // Suppress browser opening on the unattended execution host.
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
    // Translate CLI exits after code submission; retain timeout, denial, and cancellation errors.
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
