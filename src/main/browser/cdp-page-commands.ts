import type {
  BrowserEvalResult,
  BrowserGotoResult,
  BrowserPdfResult,
  BrowserScreenshotResult,
  BrowserScrollResult,
  BrowserSnapshotResult,
  BrowserWaitResult
} from '../../shared/runtime-types'
import { BrowserError } from './browser-error'
import {
  CdpBridgeCommandModule,
  type CdpScreenshotFormat,
  type CdpScrollDirection
} from './cdp-bridge-command-module'
import { buildSnapshot } from './snapshot-engine'

export class CdpPageCommands extends CdpBridgeCommandModule {
  snapshot(): Promise<BrowserSnapshotResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const tabId = this.resolveTabId(guest.id)
      const state = this.getOrCreateTabState(tabId)

      const result = await buildSnapshot(sender, state.iframeSessions, (sessionId) =>
        this.makeCdpSender(guest, sessionId)
      )
      state.snapshotResult = result

      const navId = await this.getNavigationId(sender)
      state.navigationId = navId

      return {
        browserPageId: tabId,
        snapshot: result.snapshot,
        refs: result.refs,
        url: guest.getURL(),
        title: guest.getTitle()
      }
    })
  }

  goto(url: string): Promise<BrowserGotoResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { errorText } = (await sender('Page.navigate', { url })) as {
        errorText?: string
      }

      if (errorText) {
        throw new BrowserError('browser_navigation_failed', `Navigation failed: ${errorText}`)
      }

      await this.waitForLoad(sender, guest)
      this.invalidateRefMap(guest.id)

      return { url: guest.getURL(), title: guest.getTitle() }
    })
  }

  scroll(direction: CdpScrollDirection, amount?: number): Promise<BrowserScrollResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      // Why: JS scrollBy needs no focus and is deterministic, unlike mouseWheel which is unreliable in Electron webviews.
      const expr = amount
        ? `window.scrollBy(0, ${direction === 'down' ? amount : -amount})`
        : `window.scrollBy(0, ${direction === 'down' ? 'window.innerHeight' : '-window.innerHeight'})`
      await sender('Runtime.evaluate', { expression: expr, returnByValue: true })

      return { scrolled: direction }
    })
  }

  wait(timeoutMs: number): Promise<BrowserWaitResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      await this.ensureDebuggerAttached(guest)
      await this.waitForNetworkIdle(guest, timeoutMs, 500)
      return { waited: true }
    })
  }

  pdf(): Promise<BrowserPdfResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { data } = (await sender('Page.printToPDF', {
        printBackground: true
      })) as { data: string }

      return { data }
    })
  }

  fullPageScreenshot(format: CdpScreenshotFormat): Promise<BrowserScreenshotResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const metrics = (await sender('Page.getLayoutMetrics')) as {
        cssContentSize?: { width: number; height: number }
        contentSize?: { width: number; height: number }
      }
      // Why: screenshot clip uses CSS pixels; on HiDPI, device-pixel contentSize tiles duplicates, so prefer cssContentSize.
      const contentSize = metrics.cssContentSize ?? metrics.contentSize
      if (!contentSize) {
        throw new BrowserError('browser_error', 'Unable to determine full-page screenshot bounds')
      }

      const { data } = (await sender('Page.captureScreenshot', {
        format,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.ceil(contentSize.width),
          height: Math.ceil(contentSize.height),
          scale: 1
        }
      })) as { data: string }

      return { data, format }
    })
  }

  back(): Promise<{ url: string; title: string }> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      await sender('Page.navigateToHistoryEntry', {
        entryId: await this.getPreviousHistoryEntryId(sender)
      })
      await this.waitForLoad(sender, guest)
      this.invalidateRefMap(guest.id)

      return { url: guest.getURL(), title: guest.getTitle() }
    })
  }

  reload(): Promise<{ url: string; title: string }> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      await sender('Page.reload')
      await this.waitForLoad(sender, guest)
      this.invalidateRefMap(guest.id)

      return { url: guest.getURL(), title: guest.getTitle() }
    })
  }

  screenshot(format: CdpScreenshotFormat): Promise<BrowserScreenshotResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { data } = (await sender('Page.captureScreenshot', {
        format
      })) as { data: string }

      return { data, format }
    })
  }

  evaluate(expression: string): Promise<BrowserEvalResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { result, exceptionDetails } = (await sender('Runtime.evaluate', {
        expression,
        returnByValue: true
      })) as {
        result: { value?: unknown; type: string; description?: string }
        exceptionDetails?: { text: string; exception?: { description?: string } }
      }

      if (exceptionDetails) {
        throw new BrowserError(
          'browser_eval_error',
          exceptionDetails.exception?.description ?? exceptionDetails.text
        )
      }

      const valueStr =
        result.value !== undefined ? String(result.value) : (result.description ?? '')
      // Why: include origin to match agent-browser's BrowserEvalResult shape across both bridges.
      const { result: urlResult } = (await sender('Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true
      })) as { result: { value: string } }
      return {
        result: valueStr,
        origin: urlResult.value
      }
    })
  }
}
