// orcad's own browser engine shows its tabs to no desktop or phone, so agents reach it only by asking.
import { BrowserError } from '../../browser/browser-error'
import {
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE
} from '../../../shared/browser/client-hosting/desktop-browser-bridge-protocol'
import { isDesktopBrowserBridgeHostEnabled } from '../../runtime/desktop-browser-bridge/desktop-browser-bridge-registry'
import type { RuntimeBrowserCommandHost } from '../../runtime/browser/commands/browser-command-contracts'
import {
  BROWSER_HOST_UNAVAILABLE_MESSAGE,
  canPlacePairedPage
} from '../../runtime/browser/client-pages/browser-client-page-opening'

const HEADLESS_HINT =
  "Nothing was opened. To use this host's own headless browser, which no Orca desktop or phone shows, rerun tab create with --headless."

function noVisibleBrowserMessage(): string {
  return isDesktopBrowserBridgeHostEnabled()
    ? DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE
    : BROWSER_HOST_UNAVAILABLE_MESSAGE
}

/** Refuse an agent's tab that would land where nobody sees it; `mismatch` says why a desktop can't take it. */
export function hiddenEngineTabRefusal(mismatch: string | null): BrowserError {
  if (mismatch) {
    return new BrowserError('invalid_argument', `${mismatch} ${HEADLESS_HINT}`)
  }
  return isDesktopBrowserBridgeHostEnabled()
    ? new BrowserError(
        DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
        `${DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE} ${HEADLESS_HINT}`
      )
    : new BrowserError(
        'browser_host_unavailable',
        `${BROWSER_HOST_UNAVAILABLE_MESSAGE} ${HEADLESS_HINT}`
      )
}

/** An engine with no tab here means no visible browser either, so say how to get one back. */
export function explainMissingEngineTab(
  host: RuntimeBrowserCommandHost,
  call: () => unknown
): unknown {
  const explain = (error: unknown): never => {
    if (
      error instanceof BrowserError &&
      error.code === 'browser_no_tab' &&
      host.getRuntimeBrowserPageRegistry().listPages().length === 0 &&
      !canPlacePairedPage(host)
    ) {
      throw new BrowserError(error.code, `${error.message} ${noVisibleBrowserMessage()}`)
    }
    throw error
  }
  let result: unknown
  try {
    result = call()
  } catch (error) {
    return explain(error)
  }
  return result instanceof Promise ? result.catch(explain) : result
}
