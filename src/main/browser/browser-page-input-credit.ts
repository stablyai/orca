import { BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS } from './browser-guest-input-gesture'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'

type PageCredit = { pairedDeviceId: string; settledAt: number | null }

/** The paired client whose command a page is running or just ran, so a tab the page opens follows that client. */
export class BrowserPageInputCredit {
  private readonly creditByPageId = new Map<string, PageCredit>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Runs one queued command on the page; an agent's or the CLI's command leaves no client credited. */
  async during<T>(
    browserPageId: string,
    caller: RpcCallerIdentity | undefined,
    execute: () => Promise<T>
  ): Promise<T> {
    const now = this.now()
    for (const [pageId, credit] of this.creditByPageId) {
      if (credit.settledAt !== null && !this.isRecent(credit.settledAt, now)) {
        this.creditByPageId.delete(pageId)
      }
    }
    if (caller?.kind !== 'paired-device') {
      this.creditByPageId.delete(browserPageId)
      return execute()
    }
    const credit: PageCredit = { pairedDeviceId: caller.deviceId, settledAt: null }
    this.creditByPageId.set(browserPageId, credit)
    try {
      return await execute()
    } finally {
      // The window starts once the input lands, like the guest's own gesture window.
      credit.settledAt = this.now()
    }
  }

  /** Single-use, like the input gesture it accompanies: one click cannot steer a second tab. */
  consume(browserPageId: string): string | null {
    const credit = this.creditByPageId.get(browserPageId)
    this.creditByPageId.delete(browserPageId)
    if (!credit) {
      return null
    }
    return credit.settledAt === null || this.isRecent(credit.settledAt, this.now())
      ? credit.pairedDeviceId
      : null
  }

  private isRecent(at: number, now: number): boolean {
    const elapsed = now - at
    return elapsed >= 0 && elapsed <= BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS
  }
}
