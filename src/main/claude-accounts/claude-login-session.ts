import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
import { CLAUDE_SIGN_IN_FAILED_MESSAGE } from '../../shared/claude-sign-in-link'
import { prepareClaudeSignInBrowser, type ClaudeSignInBrowser } from './claude-sign-in-browser'

// Why 10 minutes: copying the link into a private window takes longer than one click.
const LOGIN_TIMEOUT_MS = 600_000

type ClaudeLoginSessionDependencies = {
  runCommand: (
    args: string[],
    config: ClaudeCommandConfig,
    timeoutMs: number,
    options?: ClaudeCommandOptions
  ) => Promise<string>
  setCancel: (cancel: (() => boolean) | null) => void
}

/** Runs a hidden `claude auth login` that writes its login straight into the account's folder.
 *  With `onLink`, no browser opens: the sign-in link goes there instead (null if it never comes). */
export async function runClaudeLoginSession(
  folder: ClaudeCommandConfig,
  dependencies: ClaudeLoginSessionDependencies,
  onLink?: (signInLink: string | null) => void
): Promise<void> {
  const controller = new AbortController()
  const watch = new AbortController()
  let browser: ClaudeSignInBrowser | null = null
  dependencies.setCancel(() => {
    if (controller.signal.aborted) {
      return false
    }
    controller.abort()
    return true
  })
  try {
    if (onLink) {
      browser = await prepareClaudeSignInBrowser(folder).catch((error: unknown) => {
        console.warn('[claude-accounts] Could not prepare the Claude sign-in browser:', error)
        return null
      })
      // Why fail: without BROWSER, Claude opens the default browser the user asked to avoid.
      if (!browser) {
        throw new Error(CLAUDE_SIGN_IN_FAILED_MESSAGE)
      }
      void browser.nextLink(watch.signal).then(onLink)
    }
    await dependencies.runCommand(['auth', 'login', '--claudeai'], folder, LOGIN_TIMEOUT_MS, {
      signal: controller.signal,
      keepStdinOpen: true,
      ...(browser ? { browser: browser.path } : {})
    })
  } finally {
    watch.abort()
    dependencies.setCancel(null)
    await browser?.dispose().catch((error: unknown) => {
      console.warn('[claude-accounts] Could not remove the Claude sign-in browser:', error)
    })
  }
}
