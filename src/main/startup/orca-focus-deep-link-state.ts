import { orcaDeepLinkFromArguments, parseOrcaDeepLink } from '../../shared/orca-deep-link'

/**
 * Holds the pending `orca://focus/<handle>` intent for every entry point: macOS
 * open-url, Windows/Linux argv (cold launch and second-instance), and in-terminal
 * OSC 8 clicks forwarded from the renderer.
 */
export class OrcaFocusDeepLinkState {
  private pendingHandle: string | null = null

  /**
   * Returns false for anything that is not a focus link, so unrelated `orca://`
   * URLs (skill share, pair) never displace a pending intent or trigger a focus.
   * `publish` is the "try to deliver now" hook; when the window or runtime is not
   * up yet it can no-op and the intent survives for a later consume().
   */
  capture(argv: readonly string[], publish?: (handle: string) => void): boolean {
    const url = orcaDeepLinkFromArguments(argv)
    const link = url ? parseOrcaDeepLink(url) : null
    if (!link) {
      return false
    }
    // Only the newest intent is replayed; an older queued focus is stale by then.
    this.pendingHandle = link.handle
    publish?.(link.handle)
    return true
  }

  consume(): string | null {
    const handle = this.pendingHandle
    this.pendingHandle = null
    return handle
  }
}
