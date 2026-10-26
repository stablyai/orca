import { CLAUDE_SIGN_IN_FAILED_MESSAGE } from '../../shared/claude-sign-in-link'
import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
import { prepareClaudeSignInBrowser, type ClaudeSignInBrowser } from './claude-sign-in-browser'

// Allow time to copy the link into a private window and sign in.
const LOGIN_TIMEOUT_MS = 600_000

type ClaudeLoginSessionDependencies = {
  runCommand: (
    args: string[],
    config: ClaudeCommandConfig,
    timeoutMs: number,
    options?: ClaudeCommandOptions
  ) => Promise<string>
  setCancel: (cancel: (() => boolean) | null) => void
  openWslSignInLink?: ((signInLink: string) => void) | null
}

/** With `onLink`, suppress browser opening and fail if no link arrives. */
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
    // Stock WSL distros may lack a browser opener.
    const openLink =
      !onLink && folder.linuxPath !== null && folder.wslDistro !== null
        ? (dependencies.openWslSignInLink ?? undefined)
        : undefined
    // Copy-link setup must fail closed to respect the request to avoid opening a browser.
    const browser = onLink
      ? await prepareClaudeSignInBrowser(folder)
      : openLink
        ? await prepareOpenerBrowser(folder)
        : null
    const deliverLink = onLink ?? openLink
    // Suppress late links after cancellation or login completion.
    const stopped = AbortSignal.any([watch.signal, controller.signal])
    // Auto-open waits through slow distro startup without ending the login.
    const waitMs = onLink ? undefined : LOGIN_TIMEOUT_MS
    void browser?.nextLink(stopped, waitMs).then((signInLink) => {
      if (stopped.aborted) {
        return
      }
      if (signInLink) {
        deliverLink?.(signInLink)
        return
      }
      if (onLink) {
        linkMissing = true
        controller.abort()
      } else {
        // Keep login cancellable; Copy link remains available as a fallback.
        console.warn('[claude-accounts] Claude handed over no WSL sign-in link to open.')
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

// Browser-opener setup is optional for ordinary login.
async function prepareOpenerBrowser(
  folder: ClaudeCommandConfig
): Promise<ClaudeSignInBrowser | null> {
  try {
    return await prepareClaudeSignInBrowser(folder)
  } catch {
    return null
  }
}
