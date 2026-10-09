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
  openLink: (signInLink: string) => Promise<void>
}

export type ClaudeLoginLinkRequest = {
  /** Hand the link to `onLink` instead of opening the default browser. */
  copyLink: boolean
  /** The sign-in link, or null once the sign-in ends without one; called once. */
  onLink: (signInLink: string | null) => void
}

/** Runs a hidden `claude auth login` that writes its login straight into the account's folder. */
export async function runClaudeLoginSession(
  folder: ClaudeCommandConfig,
  dependencies: ClaudeLoginSessionDependencies,
  linkRequest: ClaudeLoginLinkRequest = { copyLink: false, onLink: () => {} }
): Promise<void> {
  const controller = new AbortController()
  const watch = new AbortController()
  let linkSettled = false
  const settleLink = (signInLink: string | null): void => {
    if (!linkSettled) {
      linkSettled = true
      linkRequest.onLink(signInLink)
    }
  }
  dependencies.setCancel(() => {
    if (controller.signal.aborted) {
      return false
    }
    controller.abort()
    return true
  })
  // Why null falls back: there Claude opens the default browser itself, as before.
  const browser = await prepareClaudeSignInBrowser(folder).catch((error: unknown) => {
    console.warn('[claude-accounts] Could not prepare the Claude sign-in browser:', error)
    return null
  })
  try {
    void browser?.nextLink(watch.signal).then((signInLink) => {
      if (!signInLink || linkRequest.copyLink) {
        settleLink(signInLink)
        return
      }
      dependencies.openLink(signInLink).catch((error: unknown) => {
        console.warn('[claude-accounts] Could not open the Claude sign-in page:', error)
      })
    })
    await dependencies.runCommand(['auth', 'login', '--claudeai'], folder, LOGIN_TIMEOUT_MS, {
      signal: controller.signal,
      keepStdinOpen: true,
      browser: browser?.path
    })
  } finally {
    watch.abort()
    settleLink(null)
    dependencies.setCancel(null)
    await browser?.dispose().catch((error: unknown) => {
      console.warn('[claude-accounts] Could not remove the Claude sign-in browser:', error)
    })
  }
}
