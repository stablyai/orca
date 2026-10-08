import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { terminalHandleFromArguments } from '../../shared/terminal-deep-link'

export type TerminalDeepLinkRuntime = Pick<OrcaRuntimeService, 'focusTerminal'>

type PendingTerminalDeepLink = { handle: string; retried: boolean }

/** Focuses the terminal an `orca://terminal/<handle>` link names; never spawns, types or wakes. */
export class TerminalDeepLinkState {
  private pending: PendingTerminalDeepLink | null = null

  /** Pass `runtime` only when a window graph is live; otherwise the link waits for the next one. */
  capture(argv: readonly string[], runtime: TerminalDeepLinkRuntime | null): boolean {
    const handle = terminalHandleFromArguments(argv)
    if (!handle) {
      return false
    }
    this.pending = { handle, retried: false }
    if (runtime) {
      void this.deliver(runtime)
    }
    return true
  }

  windowGraphReady(runtime: TerminalDeepLinkRuntime): void {
    if (this.pending) {
      void this.deliver(runtime)
    }
  }

  private async deliver(runtime: TerminalDeepLinkRuntime): Promise<void> {
    const link = this.pending
    if (!link) {
      return
    }
    // Why taken before the await: a graph sync landing mid-focus must not focus it twice.
    this.pending = null
    try {
      await runtime.focusTerminal(link.handle, { navigateHost: true, requireLivePty: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // Why one retry: a cold start or renderer reload reports the graph unavailable until it syncs.
      if (reason === 'runtime_unavailable' && !link.retried && !this.pending) {
        this.pending = { handle: link.handle, retried: true }
        return
      }
      console.warn(
        `[deep-link] Ignored orca://terminal/${link.handle}: ${JSON.stringify(reason.slice(0, 120))}`
      )
    }
  }
}
