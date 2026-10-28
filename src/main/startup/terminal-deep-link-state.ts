import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeTerminalSummary } from '../../shared/runtime-terminal-contracts'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import {
  formatTerminalDeepLink,
  terminalDeepLinkFromArguments,
  type TerminalDeepLink
} from '../../shared/terminal-deep-link'

export type TerminalDeepLinkHost = {
  isWindowGraphReady: () => boolean
  runtime: Pick<OrcaRuntimeService, 'focusTerminal' | 'revealTerminalPane'>
  resolveEnvironmentId: (selector: string) => string
  showEnvironmentTerminal: (
    environmentId: string,
    handle: string
  ) => Promise<Pick<RuntimeTerminalSummary, 'worktreeId' | 'tabId' | 'leafId'>>
}

/** Holds an `orca://terminal/...` link until a window can show it; a link only ever switches tabs. */
export class TerminalDeepLinkState {
  private pending: TerminalDeepLink | null = null

  /** Without a desktop window `getHost` returns null and the link waits for its first ready graph. */
  capture(argv: readonly string[], getHost: () => TerminalDeepLinkHost | null): boolean {
    const link = terminalDeepLinkFromArguments(argv)
    if (!link) {
      return false
    }
    this.pending = link
    void this.deliver(getHost)
    return true
  }

  /** Runs on every ready graph sync, so it returns before any work unless a link waits. */
  async deliver(getHost: () => TerminalDeepLinkHost | null): Promise<void> {
    const link = this.pending
    if (!link) {
      return
    }
    const host = getHost()
    if (!host?.isWindowGraphReady()) {
      return
    }
    // Taken before awaiting so a graph sync landing mid-switch cannot switch twice.
    this.pending = null
    try {
      if (!(await switchToTerminal(link, host))) {
        console.warn(`[deep-link] No window could show ${formatTerminalDeepLink(link)}`)
      }
    } catch (error) {
      // Bounded and quoted: a paired server's error text lands in this log.
      const reason = JSON.stringify(
        (error instanceof Error ? error.message : String(error)).slice(0, 120)
      )
      console.warn(`[deep-link] Ignored ${formatTerminalDeepLink(link)}: ${reason}`)
    }
  }

  /** The windowless sidecar passes a waiting link on to the desktop app as a launch argument. */
  drainArguments(): string[] {
    const link = this.pending
    this.pending = null
    return link ? [formatTerminalDeepLink(link)] : []
  }
}

/** `orca terminal switch`, except a paired server's pane opens in this window, never on that server. */
async function switchToTerminal(
  link: TerminalDeepLink,
  host: TerminalDeepLinkHost
): Promise<boolean> {
  if (link.environment === null) {
    const focus = await host.runtime.focusTerminal(link.handle, { navigateHost: true })
    return focus.navigated === true
  }
  const environmentId = host.resolveEnvironmentId(link.environment)
  const terminal = await host.showEnvironmentTerminal(environmentId, link.handle)
  const reveal = await host.runtime.revealTerminalPane({
    worktreeId: terminal.worktreeId,
    tabId: terminal.tabId,
    leafId: terminal.leafId,
    executionHostId: toRuntimeExecutionHostId(environmentId)
  })
  return reveal.navigated
}
