import { AgentBrowserBridgeFindCommands } from './agent-browser-bridge-find-commands'

/** Tab mute for a page a remote pane draws from frames; the page plays on this host. */
export abstract class AgentBrowserBridgeAudioCommands extends AgentBrowserBridgeFindCommands {
  // Not queued: like find, muting is the person's view of the page, not an action an agent's command waits on.
  setAudioMuted(muted: boolean, worktreeId?: string, browserPageId?: string): { muted: boolean } {
    const wc = this.requireUnqueuedWebContents(worktreeId, browserPageId)
    this.browserManager.setGuestAudioMuted(wc, muted)
    return { muted }
  }
}
