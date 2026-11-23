import type { BrowserSnapshotOptions } from '../../../../shared/rpc-contract/browser/browser-observation-params'
import type {
  BrowserSnapshotResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserFillResult
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../../../shared/clipboard/clipboard-text'
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser/navigation/browser-url'
import { BrowserError } from '../../browser-error'
import { ORCA_TAB_SESSION_PREFIX } from '../session-lifecycle/agent-browser-session-name'
import { FILL_ELEMENT_FUNCTION } from '../../cdp/input/browser-element-functions'
import {
  EMBEDDED_NAVIGATION_TIMEOUT_MS,
  isAbortedNavigationError,
  isWaitingForMainFrameResponse,
  waitForInFlightNavigation
} from './agent-browser-navigation-settle'
import { AgentBrowserBridgeQueue } from '../command-queue/agent-browser-bridge-queue'
import { assertRemoteCliPageAccess } from '../../routing/input-ownership/remote-cli-page-admission'
import { agentBrowserSnapshotArgs } from '../protocol/agent-browser-snapshot-arguments'
import { getBrowserPasskeyRequest } from '../../webauthn/browser-passkey-requests'
import { whenBrowserExtensionsReadyForPage } from '../../extensions/profile-sessions/browser-extension-page-start'
import { claimBrowserPageFirstLoad } from '../../guest-lifecycle/browser-page-memory'

export abstract class AgentBrowserBridgeCoreCommands extends AgentBrowserBridgeQueue {
  async snapshot(
    worktreeId?: string,
    browserPageId?: string,
    options: BrowserSnapshotOptions = {}
  ): Promise<BrowserSnapshotResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName, target) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: agent-browser's snapshot --json answers the snapshot and refs of BrowserSnapshotResult; page fields are set below.
      const result = (await this.execAgentBrowser(
        sessionName,
        agentBrowserSnapshotArgs(options)
      )) as BrowserSnapshotResult
      // The agent now holds this tree, so its next action diffs against a fresh baseline.
      this.forgetDeltaBaseline(sessionName)
      // agent-browser's snapshot carries neither, so read them off the page it captured.
      const wc = this.requireTargetWebContents(target)
      // The page may have navigated somewhere an SSH host must not see while the snapshot ran.
      assertRemoteCliPageAccess(wc.id)
      return {
        ...result,
        browserPageId: target.browserPageId,
        url: wc.getURL(),
        title: wc.getTitle(),
        passkeyRequest: getBrowserPasskeyRequest(wc.id)
      }
    })
  }

  async click(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserClickResult> {
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        return (await this.execAgentBrowser(sessionName, ['click', element])) as BrowserClickResult
      },
      { elements: [element] }
    )
  }

  async dblclick(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserClickResult> {
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: agent-browser's dblclick --json answers the BrowserClickResult shape.
        return (await this.execAgentBrowser(sessionName, [
          'dblclick',
          element
        ])) as BrowserClickResult
      },
      { elements: [element] }
    )
  }

  async goto(
    url: string,
    worktreeId?: string,
    browserPageId?: string,
    { awaitFirstLoad, ...options }: { reportEffects?: boolean; awaitFirstLoad?: boolean } = {}
  ): Promise<BrowserGotoResult> {
    return this.enqueueInertAction(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => {
        const wc = this.requireTargetWebContents(target)
        const navigationUrl = normalizeBrowserNavigationUrl(url)
        if (!navigationUrl) {
          throw new BrowserError('invalid_argument', `Unsupported browser URL: ${url}`)
        }
        // A tab opened at this URL is already loading it; loading again would resend the request.
        const firstLoad = awaitFirstLoad
          ? claimBrowserPageFirstLoad(target.browserPageId, navigationUrl)
          : null
        if (firstLoad && firstLoad.guest === wc) {
          const deadline = Date.now() + EMBEDDED_NAVIGATION_TIMEOUT_MS
          await firstLoad.load
          // As below: a page that navigated on from its first load reports once that one settles.
          const pendingUrl = this.browserManager.getInFlightNavigationUrl(wc)
          if (
            isWaitingForMainFrameResponse(wc) ||
            (pendingUrl !== null && pendingUrl !== wc.getURL())
          ) {
            await waitForInFlightNavigation(wc, Math.max(0, deadline - Date.now()))
          }
          return { url: wc.getURL(), title: wc.getTitle() }
        }
        // A new tab's profile may still be starting its extensions; its first page waits for them.
        await whenBrowserExtensionsReadyForPage(wc)
        const navigationState: { preventUnloadEvent: Electron.Event | null } = {
          preventUnloadEvent: null
        }
        const onWillPreventUnload = (event: Electron.Event): void => {
          navigationState.preventUnloadEvent = event
        }
        wc.on('will-prevent-unload', onWillPreventUnload)
        let navigationAborted = false
        const navigationDeadline = Date.now() + EMBEDDED_NAVIGATION_TIMEOUT_MS
        let navigationTimeout: ReturnType<typeof setTimeout> | null = null
        try {
          await Promise.race([
            wc.loadURL(navigationUrl),
            new Promise<never>((_resolve, reject) => {
              navigationTimeout = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Browser navigation timed out after ${EMBEDDED_NAVIGATION_TIMEOUT_MS}ms`
                    )
                  ),
                EMBEDDED_NAVIGATION_TIMEOUT_MS
              )
              navigationTimeout.unref?.()
            })
          ])
        } catch (error) {
          if (navigationTimeout) {
            clearTimeout(navigationTimeout)
            navigationTimeout = null
          }
          if (!this.getWebContents(target.webContentsId)) {
            throw this.createPageUnavailableError(
              `${ORCA_TAB_SESSION_PREFIX}${target.browserPageId}`
            )
          }
          // ERR_ABORTED can also mean the page vetoed unloading.
          if (
            !isAbortedNavigationError(error) ||
            (navigationState.preventUnloadEvent !== null &&
              !navigationState.preventUnloadEvent.defaultPrevented)
          ) {
            throw new BrowserError(
              'browser_error',
              `Failed to navigate browser page ${target.browserPageId}: ${error instanceof Error ? error.message : String(error)}`
            )
          }
          navigationAborted = true
        } finally {
          wc.removeListener('will-prevent-unload', onWillPreventUnload)
          if (navigationTimeout) {
            clearTimeout(navigationTimeout)
          }
        }
        // A superseding navigation can still be loading when the first load rejects. The outgoing
        // page (its own load ending, a beforeunload replaceState) can also settle loadURL while
        // the requested navigation is pending, so getURL() still names the outgoing document.
        const committedUrl = wc.getURL()
        const pendingUrl = this.browserManager.getInFlightNavigationUrl(wc)
        const settledBeforeCommit =
          !navigationAborted &&
          committedUrl !== navigationUrl &&
          (isWaitingForMainFrameResponse(wc) ||
            (pendingUrl !== null && pendingUrl !== committedUrl))
        const navigationInFlight = navigationAborted || settledBeforeCommit
        if (navigationInFlight) {
          const outcome = await waitForInFlightNavigation(
            wc,
            Math.max(0, navigationDeadline - Date.now())
          )
          // Only an aborted load fails at the deadline; an early-settled one reports the current page.
          if (navigationAborted && outcome === 'timed-out') {
            throw new BrowserError(
              'browser_error',
              `Failed to navigate browser page ${target.browserPageId}: Browser navigation timed out after ${EMBEDDED_NAVIGATION_TIMEOUT_MS}ms`
            )
          }
        }

        // Process swaps can replace the guest while retaining the page ID.
        const navigatedTarget = this.resolveCommandTarget(worktreeId, target.browserPageId)
        const navigatedWebContents = this.requireTargetWebContents(navigatedTarget)
        const loadError = navigationInFlight
          ? this.browserManager.getBrowserPageLoadError(target.browserPageId)
          : null
        if (loadError) {
          throw new BrowserError(
            'browser_error',
            `Failed to navigate browser page ${target.browserPageId}: ${loadError.description} (${loadError.code})`
          )
        }
        return { url: navigatedWebContents.getURL(), title: navigatedWebContents.getTitle() }
      },
      { ensureSession: false, ...options }
    )
  }

  async fill(
    element: string,
    value: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserFillResult> {
    await assertClipboardTextWriteWithinLimitWithYield(value)
    // agent-browser's fill types into whatever holds focus and sends text per character; set the
    // resolved element's value in one call instead.
    return this.enqueuePageAction(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        await this.actOnElement(sessionName, element, 'fill', FILL_ELEMENT_FUNCTION, {
          args: [value],
          movesFocus: true
        })
        return { filled: element }
      },
      { requireScopedTarget: true, elements: [element] }
    )
  }
}
