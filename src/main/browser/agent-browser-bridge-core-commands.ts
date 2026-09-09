import type {
  BrowserSnapshotResult,
  BrowserClickResult,
  BrowserGotoResult,
  BrowserFillResult
} from '../../shared/runtime-types'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { iterateBrowserTextInsertionChunks } from './browser-text-insertion'
import { BrowserError } from './cdp-bridge'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import { focusedValueSetExpression } from './agent-browser-bridge-input'
import {
  AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES,
  EMBEDDED_NAVIGATION_TIMEOUT_MS
} from './agent-browser-bridge-types'
import {
  isAbortedNavigationError,
  waitForAbortedNavigationReplacement
} from './agent-browser-bridge-process'
import { AgentBrowserBridgeQueue } from './agent-browser-bridge-queue'

export abstract class AgentBrowserBridgeCoreCommands extends AgentBrowserBridgeQueue {
  async snapshot(worktreeId?: string, browserPageId?: string): Promise<BrowserSnapshotResult> {
    // Why: snapshot creates fresh refs so it must bypass the stale-ref guard
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
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['click', element])) as BrowserClickResult
    })
  }

  async dblclick(
    element: string,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserClickResult> {
    return this.enqueueTargetedCommand(worktreeId, browserPageId, async (sessionName) => {
      return (await this.execAgentBrowser(sessionName, ['dblclick', element])) as BrowserClickResult
    })
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
          // Why: ERR_ABORTED also covers a page vetoing unload; that navigation did not succeed.
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
          // Why: a superseding navigation rejects the first load before its replacement has landed.
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

        // Why: cross-process navigation can replace the guest while retaining the same authoritative page id.
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
    // Why: agent-browser's CDP text insertion loses focus in Electron guests; edit through the browser's input pipeline instead.
    return this.enqueueTargetedCommand(
      worktreeId,
      browserPageId,
      async (sessionName) => {
        if (!(await this.isExplicitContentEditableTarget(sessionName, element))) {
          await this.execAgentBrowser(sessionName, ['focus', element])
          await this.execAgentBrowser(sessionName, [
            'eval',
            focusedValueSetExpression(JSON.stringify(''))
          ])
          for (const chunk of iterateBrowserTextInsertionChunks(
            value,
            AGENT_BROWSER_TEXT_ARGUMENT_MAX_BYTES
          )) {
            await this.execAgentBrowser(sessionName, [
              'eval',
              focusedValueSetExpression(JSON.stringify(chunk), { append: true })
            ])
          }
          await this.execAgentBrowser(sessionName, [
            'eval',
            focusedValueSetExpression(JSON.stringify(''), { append: true, dispatchEvents: true })
          ])
          return { filled: element } as BrowserFillResult
        }

        await this.fillExplicitContentEditable(sessionName, element, value)
        return { filled: element } as BrowserFillResult
      },
      { requireScopedTarget: true }
    )
  }
}
