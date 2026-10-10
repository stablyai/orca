import { CLAUDE_SIGN_IN_FAILED_MESSAGE } from '../../shared/claude-sign-in-link'
import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
import { prepareClaudeSignInBrowser } from './claude-sign-in-browser'

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
 *  With `onLink`, no browser opens: the sign-in link goes there, and no link ends the sign-in. */
export async function runClaudeLoginSession(
  folder: ClaudeCommandConfig,
  dependencies: ClaudeLoginSessionDependencies,
  onLink?: (signInLink: string) => void
): Promise<void> {
  const controller = new AbortController()
  const watch = new AbortController()
  let linkMissing = false
  dependencies.setCancel(() => {
    if (controller.signal.aborted) {
      return false
    }
    controller.abort()
    return true
  })
  try {
    // Why: if setup fails this throws; falling back would let Claude open the browser the user avoided.
    const browser = onLink ? await prepareClaudeSignInBrowser(folder) : null
    void browser?.nextLink(watch.signal).then((signInLink) => {
      if (signInLink) {
        onLink?.(signInLink)
      } else if (!watch.signal.aborted) {
        linkMissing = true
        controller.abort()
      }
    })
    try {
      await dependencies.runCommand(['auth', 'login', '--claudeai'], folder, LOGIN_TIMEOUT_MS, {
        signal: controller.signal,
        keepStdinOpen: true,
        browser: browser?.path
      })
    } catch (error) {
      throw linkMissing ? new Error(CLAUDE_SIGN_IN_FAILED_MESSAGE) : error
    } finally {
      watch.abort()
      await browser?.dispose().catch((error: unknown) => {
        console.warn('[claude-accounts] Could not remove the Claude sign-in browser:', error)
      })
    }
  } finally {
    dependencies.setCancel(null)
  }
}
