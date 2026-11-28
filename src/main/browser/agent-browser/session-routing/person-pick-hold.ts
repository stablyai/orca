import { isAgentRpcCaller } from '../../../runtime/rpc/callers/rpc-caller-identity'
import { getActiveRpcCaller } from '../../../runtime/rpc/callers/active-call'

// Spans an agent's thinking between steps; a finished, failed or disconnected agent clears within it.
export const AGENT_PAGE_ACTIVITY_IDLE_MS = 20_000

export type BrowserPagePicker = 'agent' | 'person'

/** An agent's CLI picks for the agent; a person's window, phone or relayed input picks for the person. */
export function activeRpcBrowserPagePicker(): BrowserPagePicker {
  return isAgentRpcCaller(getActiveRpcCaller()) ? 'agent' : 'person'
}

/** A person's pick never pulls an agent off the page it is driving; it waits until that page goes idle (#36108). */
export function personPickWaits(
  routedPageId: string | null,
  pickedPageId: string,
  isAgentUsingPage: (browserPageId: string) => boolean
): boolean {
  return routedPageId !== null && routedPageId !== pickedPageId && isAgentUsingPage(routedPageId)
}

/** Pages an agent drove within the idle window; a running command keeps its page marked. */
export class AgentPageUse {
  private readonly pages = new Map<string, { running: number; settledAt: number }>()

  /** Marks the page for one command; returns its settle. */
  begin(browserPageId: string): () => void {
    const use = this.pages.get(browserPageId) ?? { running: 0, settledAt: 0 }
    this.pages.set(browserPageId, use)
    use.running += 1
    let settled = false
    return () => {
      if (!settled) {
        settled = true
        use.running -= 1
        use.settledAt = Date.now()
      }
    }
  }

  readonly isUsing = (browserPageId: string): boolean => {
    const use = this.pages.get(browserPageId)
    return (
      use !== undefined &&
      (use.running > 0 || Date.now() - use.settledAt < AGENT_PAGE_ACTIVITY_IDLE_MS)
    )
  }

  forget(browserPageId: string): void {
    this.pages.delete(browserPageId)
  }
}
