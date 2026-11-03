import { isRecentBrowserGuestInput } from './browser-guest-input-gesture'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'

type Runner = { pairedDeviceId: string | null }

/** The paired client whose click or key press reached a tab last, so a tab it opens follows that client. */
export class BrowserPageInputCredit {
  // The command each page is running; queued commands run one at a time per page.
  private readonly runnerByPageId = new Map<string, Runner>()
  private readonly creditByTabId = new Map<string, { pairedDeviceId: string; at: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Nothing to credit or clear: no command is running and no credit is held. */
  get idle(): boolean {
    return this.runnerByPageId.size === 0 && this.creditByTabId.size === 0
  }

  /** Runs one queued command on the page, so input it delivers is credited to its caller. */
  async during<T>(
    browserPageId: string,
    caller: RpcCallerIdentity | undefined,
    execute: () => Promise<T>
  ): Promise<T> {
    const runner: Runner = {
      pairedDeviceId: caller?.kind === 'paired-device' ? caller.deviceId : null
    }
    this.runnerByPageId.set(browserPageId, runner)
    try {
      return await execute()
    } finally {
      if (this.runnerByPageId.get(browserPageId) === runner) {
        this.runnerByPageId.delete(browserPageId)
      }
    }
  }

  /** Activating input reached the page; the running command's paired client, if any, owns what it opens. */
  creditInput(browserTabId: string, browserPageId: string): void {
    const pairedDeviceId = this.runnerByPageId.get(browserPageId)?.pairedDeviceId ?? null
    if (!pairedDeviceId) {
      this.creditByTabId.delete(browserTabId)
      return
    }
    const now = this.now()
    // Unconsumed credits for tabs that opened nothing would otherwise pile up.
    for (const [tabId, credit] of this.creditByTabId) {
      if (!isRecentBrowserGuestInput(credit.at, now)) {
        this.creditByTabId.delete(tabId)
      }
    }
    this.creditByTabId.set(browserTabId, { pairedDeviceId, at: now })
  }

  /** Single-use, like the input gesture it accompanies: one click cannot steer a second tab. */
  consume(browserTabId: string): string | null {
    const credit = this.creditByTabId.get(browserTabId)
    this.creditByTabId.delete(browserTabId)
    return credit && isRecentBrowserGuestInput(credit.at, this.now()) ? credit.pairedDeviceId : null
  }
}
