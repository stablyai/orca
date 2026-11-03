import { REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../shared/github/work-item-target'
import { verifyRelayedGitHubAuthority } from './relay-github-authority'
import { createRelayedBrowserTab } from './relayed-browser-tab-create'
import type { OpenedRelayLink, RelayLink } from './mobile-desktop-relay-link'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

/** Send one rewritten phone request after the checks its method needs; 'answered' means a reply already went back or none is owed. */
export async function sendRelayedRequest(args: {
  link: RelayLink
  opened: OpenedRelayLink
  method: string
  outgoing: string
  hosts: MobileDesktopRelayHosts
  prepareBrowserHost?: (host: MobileDesktopRelayHost) => Promise<string | null>
  timeoutMs: number
  isCurrent: () => boolean
  refuse: (code: string, message: string) => void
}): Promise<'sent' | 'unsent' | 'answered'> {
  const { link, method, outgoing, isCurrent } = args
  const { socket, host } = args.opened
  if (
    Buffer.byteLength(outgoing) > REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES &&
    !link.replies.supportsOrdinaryMessages()
  ) {
    // Answer through the same correlation map without sending an oversized frame to an old peer.
    args.refuse('invalid_argument', 'This server connection cannot carry a request this large.')
    return 'answered'
  }
  try {
    if (method === 'status.get') {
      await args.prepareBrowserHost?.(host)
    }
    if (
      method === 'browser.tabCreate' &&
      (await createRelayedBrowserTab({
        hosts: args.hosts,
        prepareBrowserHost: args.prepareBrowserHost,
        link,
        frame: outgoing,
        socket,
        isCurrent,
        timeoutMs: args.timeoutMs
      }))
    ) {
      return 'answered'
    }
    const verification = verifyRelayedGitHubAuthority({
      method,
      frame: outgoing,
      socket,
      replies: link.replies,
      isCurrent,
      timeoutMs: args.timeoutMs
    })
    if (verification) {
      await verification
    }
    if (!isCurrent()) {
      return 'answered'
    }
  } catch (error) {
    if (isCurrent()) {
      args.refuse(
        method === 'browser.tabCreate' ||
          method === 'status.get' ||
          (error instanceof Error && error.message === GITHUB_EXACT_OPERATION_UNSUPPORTED)
          ? 'remote_runtime_unavailable'
          : 'runtime_source_mismatch',
        error instanceof Error ? error.message : 'Unable to confirm the executing Orca server.'
      )
    }
    return 'answered'
  }
  return socket.send(outgoing) ? 'sent' : 'unsent'
}
