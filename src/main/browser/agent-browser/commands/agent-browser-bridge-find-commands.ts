import type { WebContents } from 'electron'
import { BrowserError } from '../../browser-error'
import type { BrowserFindInPageResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { captureRemoteCliBrowserRevocation } from '../../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { AgentBrowserBridgeUtilityCommands } from './agent-browser-bridge-page-commands'

const FIND_RESULT_TIMEOUT_MS = 5_000

/** Chromium's find bar for a page a remote pane draws from frames; the pane keeps the bar, the host runs the search. */
export abstract class AgentBrowserBridgeFindCommands extends AgentBrowserBridgeUtilityCommands {
  // Not queued: like zoom, find is the person's view of the page, not an action an agent's command waits on.
  async findInPage(
    text: string,
    options: { forward?: boolean; findNext?: boolean },
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserFindInPageResult> {
    const wc = this.requireUnqueuedWebContents(worktreeId, browserPageId)
    return await new Promise<BrowserFindInPageResult>((resolve, reject) => {
      let requestId: number | null = null
      let latest: BrowserFindInPageResult | null = null
      const finish = (): void => {
        clearTimeout(timer)
        wc.removeListener('found-in-page', onFound)
        wc.removeListener('destroyed', onDestroyed)
      }
      const onFound = (_event: Electron.Event, result: Electron.Result): void => {
        if (result.requestId !== requestId) {
          return
        }
        latest = { activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches }
        if (result.finalUpdate) {
          finish()
          resolve(latest)
        }
      }
      const onDestroyed = (): void => {
        finish()
        reject(new BrowserError('browser_no_tab', 'Tab is no longer available'))
      }
      // Chromium can skip the final update when a newer search on the page supersedes this one.
      const timer = setTimeout(() => {
        finish()
        if (latest) {
          resolve(latest)
        } else {
          reject(new BrowserError('browser_error', 'Find in page did not answer.'))
        }
      }, FIND_RESULT_TIMEOUT_MS)
      wc.on('found-in-page', onFound)
      wc.once('destroyed', onDestroyed)
      try {
        requestId = wc.findInPage(text, options)
      } catch (error) {
        finish()
        reject(error)
      }
    })
  }

  stopFindInPage(worktreeId?: string, browserPageId?: string): { stopped: true } {
    this.requireUnqueuedWebContents(worktreeId, browserPageId).stopFindInPage('clearSelection')
    return { stopped: true }
  }

  private requireUnqueuedWebContents(worktreeId?: string, browserPageId?: string): WebContents {
    this.assertCommandAdmission()
    const assertNotRevoked = captureRemoteCliBrowserRevocation()
    const { webContentsId } = this.resolveCommandTarget(worktreeId, browserPageId)
    assertNotRevoked(webContentsId)
    const wc = this.getWebContents(webContentsId)
    if (!wc) {
      throw new BrowserError('browser_no_tab', 'Tab is no longer available')
    }
    return wc
  }
}
