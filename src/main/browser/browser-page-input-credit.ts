import { BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS } from './browser-guest-input-gesture'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'

type Runner = { pairedDeviceId: string | null }

/** The paired client whose click or key press reached a tab last, so a tab it opens follows that client. */
export class BrowserPageInputCredit {
  // The command each page is running; queued commands run one at a time per page.
  private readonly runnerByPageId = new Map<string, Runner>()
  private readonly creditByTabId = new Map<string, { pairedDeviceId: string; at: number }>()

  constructor(private readonly now: () => number = Date.now) {}

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
    const now = this.now()
    for (const [tabId, credit] of this.creditByTabId) {
      if (!this.isRecent(credit.at, now)) {
        this.creditByTabId.delete(tabId)
      }
    }
    const pairedDeviceId = this.runnerByPageId.get(browserPageId)?.pairedDeviceId ?? null
    if (pairedDeviceId) {
      this.creditByTabId.set(browserTabId, { pairedDeviceId, at: now })
    } else {
      this.creditByTabId.delete(browserTabId)
    }
  }

  /** Single-use, like the input gesture it accompanies: one click cannot steer a second tab. */
  consume(browserTabId: string): string | null {
    const credit = this.creditByTabId.get(browserTabId)
    this.creditByTabId.delete(browserTabId)
    return credit && this.isRecent(credit.at, this.now()) ? credit.pairedDeviceId : null
  }

  private isRecent(at: number, now: number): boolean {
    const elapsed = now - at
    return elapsed >= 0 && elapsed <= BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS
  }
}
