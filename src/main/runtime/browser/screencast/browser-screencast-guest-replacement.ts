import type { BrowserScreencastSession } from '../../../browser/cdp/screencast/browser-screencast-stream-types'

type ReplaceableStream = {
  stopping: boolean
  session: Pick<BrowserScreencastSession, 'done'> | null
  started: Promise<Pick<BrowserScreencastSession, 'done' | 'stop'>>
}

/** Guest swaps under one page id (a profile switch): streams end with `end`, and new viewers wait for the new guest. */
export class BrowserScreencastGuestReplacements<Stream extends ReplaceableStream> {
  private readonly byPageId = new Map<string, Promise<void>>()

  constructor(private readonly activeByPageId: Map<string, Stream>) {}

  /**
   * Resolves once no replacement or stop is under way for the page. Callers read and start the
   * page's stream in the same synchronous step after this, so two viewers never both start one.
   */
  async settle(browserPageId: string): Promise<void> {
    for (;;) {
      const active = this.activeByPageId.get(browserPageId)
      const wait =
        this.byPageId.get(browserPageId) ?? (active?.stopping ? active.session?.done : undefined)
      if (!wait) {
        return
      }
      await wait
    }
  }

  /** Ends the page's streams so viewers resubscribe instead of failing on detach, then swaps its guest. */
  async replace(browserPageId: string, swap: () => Promise<void>): Promise<void> {
    // Switches of one page run in order, so the last one asked for is the one that sticks.
    const previous = this.byPageId.get(browserPageId)
    const replacement = (async () => {
      await previous
      const active = this.activeByPageId.get(browserPageId)
      const session = active ? await active.started.catch(() => null) : null
      if (active && session) {
        active.stopping = true
        session.stop()
        await session.done
      }
      await swap()
    })()
    const fence = replacement.catch(() => {})
    this.byPageId.set(browserPageId, fence)
    try {
      await replacement
    } finally {
      if (this.byPageId.get(browserPageId) === fence) {
        this.byPageId.delete(browserPageId)
      }
    }
  }
}
