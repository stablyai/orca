import type { WebContents } from 'electron'
import type { AgentBrowserBridge } from '../agent-browser/agent-browser-bridge'
import type { BrowserManager } from '../guest-lifecycle/manager/browser-manager'
import { readBrowserGuestDiscardProtection } from '../guest-lifecycle/manager/registration/browser-guest-discard-protection'
import { getBrowserJavaScriptDialog } from '../guest-lifecycle/prompts/browser-javascript-dialogs'
import { rendererPublicationThrottle } from '../../window/visibility/renderer-publication-throttle'
import {
  readBrowserMemorySaverPolicy,
  type BrowserMemorySaverGlobalSettings
} from '../../../shared/browser/guest-lifecycle/browser-memory-saver'

/** Serve pages follow Settings > Browser > Memory Saver: its switch and its idle hours; 0 keeps every page. */
export function memorySaverIdleMs(settings: BrowserMemorySaverGlobalSettings | undefined): number {
  const policy = readBrowserMemorySaverPolicy(settings)
  return policy.enabled ? policy.idleMs : 0
}

/** Freeing would retarget page-less commands to another page, or drop the agent's request routes,
 * HAR capture, an open dialog, the page's popups, or what the desktop Memory Saver keeps. */
export function mustKeepOffscreenPage(
  browserPageId: string,
  contents: WebContents,
  deps: {
    browserManager: Pick<BrowserManager, 'isAgentUsingPage' | 'getPopupPages'>
    bridge: Pick<AgentBrowserBridge, 'isRoutedPage' | 'holdsPageNetworkState'> | null
  }
): boolean {
  return (
    deps.browserManager.isAgentUsingPage(browserPageId) ||
    deps.bridge?.isRoutedPage(browserPageId) === true ||
    deps.bridge?.holdsPageNetworkState(browserPageId) === true ||
    getBrowserJavaScriptDialog(contents.id) !== null ||
    readBrowserGuestDiscardProtection(contents).protection === 'protected' ||
    deps.browserManager.getPopupPages().some((popup) => popup.openerBrowserPageId === browserPageId)
  )
}

/** Fires once a page has gone the idle time without a command, capture or viewer lease. */
export class OffscreenPageIdleClock {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly untracks = new Map<string, () => void>()

  // Read on every arm, so a changed setting applies from each page's next idle period.
  constructor(private readonly idleMs: () => number) {}

  track(browserPageId: string, contents: WebContents, onIdle: () => void): void {
    const arm = (): void => {
      this.clear(browserPageId)
      const idleMs = this.idleMs()
      if (idleMs <= 0) {
        return
      }
      this.timers.set(
        browserPageId,
        setTimeout(() => {
          this.timers.delete(browserPageId)
          onIdle()
        }, idleMs)
      )
    }
    const stopObserving = rendererPublicationThrottle.observe(contents, (leased) =>
      leased ? this.clear(browserPageId) : arm()
    )
    this.untracks.set(browserPageId, () => {
      stopObserving()
      this.clear(browserPageId)
    })
    arm()
  }

  /** Starts the idle time over, as when a page that could not be freed is checked again. */
  restart(browserPageId: string, contents: WebContents, onIdle: () => void): void {
    this.untrack(browserPageId)
    this.track(browserPageId, contents, onIdle)
  }

  untrack(browserPageId: string): void {
    this.untracks.get(browserPageId)?.()
    this.untracks.delete(browserPageId)
  }

  private clear(browserPageId: string): void {
    const timer = this.timers.get(browserPageId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(browserPageId)
    }
  }
}
