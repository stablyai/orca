import { setTimeout as delay } from 'node:timers/promises'
import {
  signInCallbackPort,
  type HostAccountSignInPrompt
} from '../../../shared/agent-accounts/host-account-sign-in-types'
import type { prepareClaudeSignInBrowser } from './claude-sign-in-browser'

// Claude prints its paste-code page right after handing BROWSER the callback link.
const PASTE_LINK_GRACE_MS = 2_000

/** Publishes the callback link Claude handed BROWSER, with its paste-code page as a fallback. */
export async function publishCallbackLink(
  browser: Awaited<ReturnType<typeof prepareClaudeSignInBrowser>>,
  signal: AbortSignal,
  pasteUrl: () => string | null,
  publish: (prompt: HostAccountSignInPrompt) => void,
  fallBackToPaste: () => void
): Promise<void> {
  const link = await browser.nextLink(signal)
  const callbackPort = link ? signInCallbackPort(link) : null
  if (!link || callbackPort === null) {
    if (signal.aborted) {
      return
    }
    // No forwardable callback: the paste-code page signs in, now or whenever Claude prints it.
    fallBackToPaste()
    const url = pasteUrl()
    if (url) {
      publish({ url, userCode: null, needsCode: true })
    }
    return
  }
  const deadline = Date.now() + PASTE_LINK_GRACE_MS
  while (!pasteUrl() && !signal.aborted && Date.now() < deadline) {
    await delay(100, undefined, { signal }).catch(() => {})
  }
  if (signal.aborted) {
    return
  }
  const url = pasteUrl()
  publish({
    url: link,
    userCode: null,
    needsCode: true,
    callbackPort,
    ...(url ? { pasteUrl: url } : {})
  })
}
