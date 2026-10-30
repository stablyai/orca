import type {
  BrowserSnapshotResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserFillResult
} from '../../shared/runtime-types'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { BrowserError } from './cdp-bridge'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import { FILL_ELEMENT_FUNCTION } from './browser-element-functions'
import { EMBEDDED_NAVIGATION_TIMEOUT_MS } from './agent-browser-bridge-types'
import {
  isAbortedNavigationError,
  waitForAbortedNavigationReplacement
} from './agent-browser-bridge-process'
import { AgentBrowserBridgeQueue } from './agent-browser-bridge-queue'

export abstract class AgentBrowserBridgeCoreCommands extends AgentBrowserBridgeQueue {
  async snapshot(worktreeId?: string, browserPageId?: string): Promise<BrowserSnapshotResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName, target) => {
      const result = (await this.execAgentBrowser(sessionName, [
        'snapshot'
      ])) as BrowserSnapshotResult
      return {
        ...result,
        browserPageId: target.browserPageId
      }
    })
  }

  async click(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserClickResult> {
    return this.enqueueTargetedCommand(
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
    return this.enqueueTargetedCommand(
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

  async goto(url: string, worktreeId?: string, browserPageId?: string): Promise<BrowserGotoResult> {
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (_sessionName, target) => {
        const wc = this.requireTargetWebContents(target)
        const navigationUrl = normalizeBrowserNavigationUrl(url)
        if (!navigationUrl) {
          throw new BrowserError('invalid_argument', `Unsupported browser URL: ${url}`)
        }
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
          // A superseding navigation can still be loading when the first load rejects.
          await waitForAbortedNavigationReplacement(
            wc,
            target.browserPageId,
            Math.max(0, navigationDeadline - Date.now())
          )
        } finally {
          wc.removeListener('will-prevent-unload', onWillPreventUnload)
          if (navigationTimeout) {
            clearTimeout(navigationTimeout)
          }
        }

        // Process swaps can replace the guest while retaining the page ID.
        const navigatedTarget = this.resolveCommandTarget(worktreeId, target.browserPageId)
        const navigatedWebContents = this.requireTargetWebContents(navigatedTarget)
        const loadError = navigationAborted
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
      { ensureSession: false }
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
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        await this.actOnElement(sessionName, element, 'fill', FILL_ELEMENT_FUNCTION, [value])
        return { filled: element }
      },
      { requireScopedTarget: true, elements: [element] }
    )
  }
}
