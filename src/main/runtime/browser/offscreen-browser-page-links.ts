import { BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS } from '../../browser/browser-guest-input-gesture'
import type { OffscreenBrowserTabOpenRequest } from '../../browser/browser-manager-state'
import type { RuntimeBrowserTabCreation } from './browser-tab-creation'

type BrowserInputCaller = { pairedDeviceId: string; clientKind: 'mobile' | 'runtime' }

/** Opens a windowless host's page links as tabs, in front only for the paired client that clicked. */
export class OffscreenBrowserPageLinks {
  private readonly recentInputByPageId = new Map<
    string,
    { caller: BrowserInputCaller; at: number }
  >()

  constructor(
    private readonly browserTabCreate: RuntimeBrowserTabCreation['browserTabCreate'],
    private readonly now: () => number = Date.now
  ) {}

  noteInput(
    browserPageId: string | undefined,
    { pairedDeviceId, clientKind }: { pairedDeviceId?: string; clientKind?: 'mobile' | 'runtime' }
  ): void {
    if (!browserPageId || !pairedDeviceId || !clientKind) {
      return
    }
    const at = this.now()
    for (const [pageId, entry] of this.recentInputByPageId) {
      if (!this.isRecent(entry.at, at)) {
        this.recentInputByPageId.delete(pageId)
      }
    }
    this.recentInputByPageId.set(browserPageId, { caller: { pairedDeviceId, clientKind }, at })
  }

  open(request: OffscreenBrowserTabOpenRequest): void {
    const caller = this.consumeCaller(request.openerPageId)
    void this.browserTabCreate(
      {
        url: request.url,
        // Without a client that clicked, no client's view moves.
        activate: caller !== null && request.activate,
        ...(request.worktreeId ? { worktree: `id:${request.worktreeId}` } : {}),
        ...(request.profileId ? { profileId: request.profileId } : {})
      },
      caller ? { ...caller, follows: true } : undefined
    ).catch((error: unknown) => {
      console.warn('[browser] could not open a page link as a tab:', error)
    })
  }

  /** Single-use, like the input gesture it accompanies: one click cannot steer a second tab. */
  private consumeCaller(browserPageId: string): BrowserInputCaller | null {
    const entry = this.recentInputByPageId.get(browserPageId)
    this.recentInputByPageId.delete(browserPageId)
    return entry && this.isRecent(entry.at, this.now()) ? entry.caller : null
  }

  private isRecent(at: number, now: number): boolean {
    const elapsed = now - at
    return elapsed >= 0 && elapsed <= BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS
  }
}
