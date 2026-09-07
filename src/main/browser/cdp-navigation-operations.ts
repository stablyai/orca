import type { WebContents } from 'electron'
import { BrowserError } from './browser-error'
import type { CdpCommandSender } from './snapshot-engine'

export class CdpNavigationOperations {
  async getNavigationId(sender: CdpCommandSender): Promise<string> {
    const { entries, currentIndex } = (await sender('Page.getNavigationHistory')) as {
      entries: { id: number; url: string }[]
      currentIndex: number
    }
    const current = entries[currentIndex]
    return current ? `${current.id}:${current.url}` : 'unknown'
  }

  async getPreviousHistoryEntryId(sender: CdpCommandSender): Promise<number> {
    const { entries, currentIndex } = (await sender('Page.getNavigationHistory')) as {
      entries: { id: number }[]
      currentIndex: number
    }
    if (currentIndex <= 0) {
      throw new BrowserError('browser_navigation_failed', 'No previous history entry.')
    }
    return entries[currentIndex - 1].id
  }

  async waitForLoad(sender: CdpCommandSender, guest: WebContents): Promise<void> {
    // Why: SPAs fire 'load' before async content renders, so also wait for 500ms of network idle.
    const TIMEOUT_MS = 25_000
    const IDLE_MS = 500
    const startedAt = Date.now()

    // Phase 1: wait for readyState=complete
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let pollTimer: ReturnType<typeof setTimeout> | null = null

      const finish = (callback: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (pollTimer) {
          clearTimeout(pollTimer)
          pollTimer = null
        }
        callback()
      }

      const timeout = setTimeout(() => {
        finish(() => reject(new BrowserError('browser_timeout', 'Page load timed out.')))
      }, TIMEOUT_MS)

      const check = async (): Promise<void> => {
        if (settled) {
          return
        }
        try {
          const { result } = (await sender('Runtime.evaluate', {
            expression: 'document.readyState',
            returnByValue: true
          })) as { result: { value: string } }
          if (settled) {
            return
          }
          if (result.value === 'complete') {
            finish(resolve)
          } else {
            pollTimer = setTimeout(() => {
              pollTimer = null
              void check()
            }, 100)
          }
        } catch {
          finish(resolve)
        }
      }
      void check()
    })

    // Phase 2: wait for network idle
    const remaining = TIMEOUT_MS - (Date.now() - startedAt)
    if (remaining <= 0) {
      return
    }
    await this.waitForNetworkIdle(guest, Math.min(remaining, 5000), IDLE_MS)
  }

  waitForNetworkIdle(guest: WebContents, timeoutMs: number, idleMs: number): Promise<void> {
    return new Promise((resolve) => {
      let pending = 0
      let settled = false
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const overallTimeout = setTimeout(done, timeoutMs)

      function done(): void {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(overallTimeout)
        if (idleTimer) {
          clearTimeout(idleTimer)
        }
        guest.debugger.removeListener('message', onMessage)
        resolve()
      }

      function checkIdle(): void {
        if (pending <= 0) {
          if (idleTimer) {
            clearTimeout(idleTimer)
          }
          idleTimer = setTimeout(done, idleMs)
        }
      }

      function onMessage(_event: unknown, method: string): void {
        if (method === 'Network.requestWillBeSent') {
          pending++
          if (idleTimer) {
            clearTimeout(idleTimer)
            idleTimer = null
          }
        } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
          pending = Math.max(0, pending - 1)
          checkIdle()
        }
      }

      guest.debugger.on('message', onMessage)
      checkIdle()
    })
  }
}
