import { focusDeepLinkFromArguments, type OrcaFocusDeepLink } from '../deep-link/orca-deep-link'

/**
 * Holds the pending `orca://focus` intent from every entry point — macOS `open-url`,
 * Windows/Linux second-instance argv, and the cold-launch `process.argv`.
 *
 * Mirrors SkillShareDeepLinkState: `capture` records the intent and, when a `publish`
 * hook is supplied, asks the caller to deliver it now; a cold launch captures without
 * one and replays once the window and runtime exist.
 */
export class OrcaFocusDeepLinkState {
  private pending: OrcaFocusDeepLink | null = null

  /** Returns false for argv without a focus link, leaving any pending intent untouched. */
  capture(argv: readonly string[], publish?: () => void): boolean {
    const link = focusDeepLinkFromArguments(argv)
    if (!link) {
      return false
    }
    // Why newest wins: an older queued focus is stale by the time a later one arrives.
    this.pending = link
    publish?.()
    return true
  }

  consume(): OrcaFocusDeepLink | null {
    const link = this.pending
    this.pending = null
    return link
  }
}
