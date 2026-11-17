import { stripAnsiEscapeSequences } from '../../../shared/terminal/protocol/escape/ansi-escape-sequences'
import type {
  HostAccountSignInChannel,
  HostAccountSignInPrompt
} from '../../../shared/agent-accounts/host-account-sign-in-types'
import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
import { isClaudeLocalSignInLink, prepareClaudeSignInBrowser } from './claude-sign-in-browser'
import { publishCallbackLink } from './claude-pasted-code-callback-link'

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
  const linkWatch = new AbortController()
  const abort = (): boolean => {
    if (controller.signal.aborted) {
      return false
    }
    controller.abort()
    return true
  }
  setCancel(abort)
  channel.signal.addEventListener('abort', abort, { once: true })
  controller.signal.addEventListener('abort', () => linkWatch.abort(), { once: true })
  let scanned = ''
  let prompted = false
  let pasteUrl: string | null = null
  // Set once the BROWSER link turned out unforwardable; the paste page is then the prompt.
  let pasteOnly = !channel.callback
  let sendToClaude: ((text: string) => void) | null = null
  let codeSent = false
  let browser: Awaited<ReturnType<typeof prepareClaudeSignInBrowser>> | null = null
  const publish = (prompt: HostAccountSignInPrompt): void => {
    if (prompted) {
      return
    }
    prompted = true
    channel.onPrompt(prompt)
    void channel.nextCode().then(
      (code) => {
        codeSent = true
        sendToClaude?.(`${code}\n`)
      },
      () => {}
    )
  }
  try {
    // Suppress browser opening on the unattended execution host.
    browser = await prepareClaudeSignInBrowser(folder)
    if (channel.callback) {
      void publishCallbackLink(
        browser,
        linkWatch.signal,
        () => pasteUrl,
        publish,
        () => {
          pasteOnly = true
        }
      )
    }
    await runCommand(['auth', 'login', '--claudeai'], folder, LOGIN_TIMEOUT_MS, {
      signal: controller.signal,
      keepStdinOpen: true,
      browser: browser.path,
      onStdin: (send) => {
        sendToClaude = send
      },
      onStdout: (text) => {
        if (prompted || pasteUrl) {
          return
        }
        scanned = `${scanned}${text}`.slice(-MAX_SCAN_CHARS)
        const url = parseClaudePastedCodeSignInLink(scanned)
        if (!url) {
          return
        }
        pasteUrl = url
        if (pasteOnly) {
          publish({ url, userCode: null, needsCode: true })
        }
      }
    })
  } catch (error) {
    // Translate CLI exits after code submission; retain timeout, denial, and cancellation errors.
    const exited = error instanceof Error && /^Claude command (failed|exited)/.test(error.message)
    throw codeSent && exited && !controller.signal.aborted
      ? new Error(CLAUDE_PASTED_CODE_REJECTED_MESSAGE, { cause: error })
      : error
  } finally {
    linkWatch.abort()
    channel.signal.removeEventListener('abort', abort)
    setCancel(null)
    await browser?.dispose().catch((error: unknown) => {
      console.warn('[claude-accounts] Could not remove the Claude sign-in browser:', error)
    })
  }
}
