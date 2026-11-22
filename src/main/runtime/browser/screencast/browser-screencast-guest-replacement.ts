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

  /** The page's stream a new viewer may join, once no replacement or stop is under way. */
  async settledStream(browserPageId: string): Promise<Stream | undefined> {
    for (;;) {
      const replacement = this.byPageId.get(browserPageId)
      const active = this.activeByPageId.get(browserPageId)
      if (replacement) {
        await replacement
      } else if (active?.stopping) {
        await active.session?.done
      } else {
        return active
      }
    }
  }

  /** Ends the page's streams so viewers resubscribe instead of failing on detach, then swaps its guest. */
  async replace(browserPageId: string, swap: () => Promise<void>): Promise<void> {
    const replacement = (async () => {
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
