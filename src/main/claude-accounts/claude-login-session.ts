import { CLAUDE_SIGN_IN_FAILED_MESSAGE } from '../../shared/claude-sign-in-link'
import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
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
  /** Opens a WSL login's sign-in link on this computer; absent where Orca cannot open one. */
  openWslSignInLink?: ((signInLink: string) => void) | null
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
    // Why: stock distros have no xdg-open, wslview or BROWSER, so Claude in WSL opens nothing.
    const openLink =
      !onLink && folder.linuxPath !== null && folder.wslDistro !== null
        ? (dependencies.openWslSignInLink ?? undefined)
        : undefined
    // Why: if setup fails this throws; falling back would let Claude open the browser the user avoided.
    const browser = onLink
      ? await prepareClaudeSignInBrowser(folder)
      : openLink
        ? await prepareOpenerBrowser(folder)
        : null
    const deliverLink = onLink ?? openLink
    // Why both signals: a cancelled login must not open a tab for a link Claude wrote as it died.
    const stopped = AbortSignal.any([watch.signal, controller.signal])
    // Why the full login window: auto-open never ends the login, and a cold distro can be slow.
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
        // Why not end it: the login stays cancellable and Copy link remains the fallback.
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

// Why null on failure: an auto-open that cannot be set up leaves the login as it was before.
async function prepareOpenerBrowser(
  folder: ClaudeCommandConfig
): Promise<ClaudeSignInBrowser | null> {
  try {
    return await prepareClaudeSignInBrowser(folder)
  } catch {
    return null
  }
}
