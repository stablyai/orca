import { BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS } from '../../browser/browser-guest-input-gesture'
import type { OffscreenBrowserTabOpenRequest } from '../../browser/browser-manager-state'
import type { RuntimeBrowserTabCreation } from './browser-tab-creation'

type BrowserInputCaller = { pairedDeviceId: string; clientKind: 'mobile' | 'runtime' }
type PageInput = { caller: BrowserInputCaller; settledAt: number | null }

/** Opens a windowless host's page links as tabs, in front only for the paired client that clicked. */
export class OffscreenBrowserPageLinks {
  // A page's latest input; its window starts once delivery settles, so queued input keeps its client.
  private readonly latestInputByPageId = new Map<string, PageInput>()

  constructor(
    private readonly browserTabCreate: RuntimeBrowserTabCreation['browserTabCreate'],
    private readonly now: () => number = Date.now
  ) {}

  /** Delivers input to a page, naming the paired client a link it opens belongs to; other input names none. */
  async deliverInput<T>(
    browserPageId: string | undefined,
    { pairedDeviceId, clientKind }: { pairedDeviceId?: string; clientKind?: 'mobile' | 'runtime' },
    deliver: () => Promise<T>
  ): Promise<T> {
    if (!browserPageId) {
      return deliver()
    }
    const now = this.now()
    for (const [pageId, input] of this.latestInputByPageId) {
      if (input.settledAt !== null && !this.isRecent(input.settledAt, now)) {
        this.latestInputByPageId.delete(pageId)
      }
    }
    if (!pairedDeviceId || !clientKind) {
      this.latestInputByPageId.delete(browserPageId)
      return deliver()
    }
    const input: PageInput = { caller: { pairedDeviceId, clientKind }, settledAt: null }
    this.latestInputByPageId.set(browserPageId, input)
    try {
      return await deliver()
    } finally {
      input.settledAt = this.now()
    }
  }

  open(request: OffscreenBrowserTabOpenRequest): void {
    const caller = this.consumeCaller(request.openerPageId)
    void this.browserTabCreate(
      {
        url: request.url,
        activate: caller !== null && request.activate,
        ...(request.worktreeId ? { worktree: `id:${request.worktreeId}` } : {}),
        ...(request.profileId ? { profileId: request.profileId } : {})
      },
      // Without a client that clicked, no view moves: no client's and not the agent's.
      caller ? { ...caller, follows: true } : { leavesAgentTab: true }
    ).catch((error: unknown) => {
      console.warn('[browser] could not open a page link as a tab:', error)
    })
  }

  /** Single-use, like the input gesture it accompanies: one click cannot steer a second tab. */
  private consumeCaller(browserPageId: string): BrowserInputCaller | null {
    const input = this.latestInputByPageId.get(browserPageId)
    this.latestInputByPageId.delete(browserPageId)
    if (!input) {
      return null
    }
    return input.settledAt === null || this.isRecent(input.settledAt, this.now())
      ? input.caller
      : null
  }

  private isRecent(at: number, now: number): boolean {
    const elapsed = now - at
    return elapsed >= 0 && elapsed <= BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS
  }
}
