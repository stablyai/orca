import {
  BridgeInitRouteSchema,
  type BridgeClientMessage,
  type BridgeInitRoute
} from './bridge/bridge-envelope'
import { readBridgeRouteUpdate } from './bridge/bridge-route-update'
import {
  BRIDGE_SAFE_AREA_ACCEPT,
  sameSafeAreaInsets,
  ZERO_SAFE_AREA_INSETS,
  type BridgeSafeAreaInsets
} from './bridge/bridge-safe-area-insets'

/** The screen one host is serving, which is the one field of `init` that moves under a live page. */
export type BridgeHostRoute = {
  /** Null when this shell named a screen the protocol does not allow; no session is served then. */
  readonly current: () => BridgeInitRoute | null
  /** Why the opened route was refused, for the line the host prints at construction. */
  readonly openIssue: () => string
  /** What the page's latest `ready` said it can be sent. Reset by each document's `ready`. */
  readonly readReady: (message: Extract<BridgeClientMessage, { type: 'ready' }>) => void
  /**
   * Hands the page a rewritten param for the screen it is already on, and sends one `init` when
   * that moved the route. The held route moves either way, so a page that reloads inside this
   * mount is given the newest one on its next `ready` even when it is too old to be sent one in
   * flight.
   *
   * Answers nothing, and nothing here learns anything from a post (ruling 34). It cannot: a frame
   * the page received and then failed to handle is caught by the page and reported there, so what
   * is left is a post refused because no document holds the view — the handle is gone, the session
   * changed, or this host is closed. Every one of those is followed by a fresh document's `ready`,
   * which is answered with the route held now, because the held route advances on `hold` as well
   * as on `send`. The request that route carries is spent by the page, which erases the param.
   */
  readonly publish: (next: BridgeInitRoute, deliverable: boolean) => void
  /** The insets the next `init` carries. */
  readonly safeAreaInsets: () => BridgeSafeAreaInsets
  /**
   * Moves the held insets, and sends one `init` when they moved and the page reads them. The same
   * lane as a pane update: held either way, so the next `ready` carries them.
   */
  readonly publishSafeAreaInsets: (next: BridgeSafeAreaInsets, deliverable: boolean) => void
}

/**
 * One host's route, parsed once and reassigned only by `publish`.
 *
 * Parsed here against the same schema the page reads it with, rather than trusted. The producer
 * interpolates a host id into a pathname, so a host id carrying `?`, `#`, whitespace or a dot
 * segment reaches the wire as a route no page will accept; without this the page refuses the whole
 * `init`, asks again on its backoff forever, and the shell un-hides a WebView that will never
 * paint.
 *
 * Its own module because the route stopped being a constant (ruling 33.1): a notification tap for
 * another pane of the session on screen rewrites one param of a page that is already mounted, and
 * what the host may do about that is a decision with four inputs rather than a field. It holds no
 * more than that (ruling 34): what the page has received is the page's business, and the only
 * thing here that outlives a call is the route the shell is on.
 */
export function createBridgeHostRoute(args: {
  /** What the shell asked for, unparsed. */
  opened: BridgeInitRoute
  /** True when the pair beside the route was itself refused; then no session is served either. */
  refused: boolean
  sendInit: () => void
  onRefused: (issue: string) => void
  safeAreaInsets?: BridgeSafeAreaInsets
}): BridgeHostRoute {
  const parsed = BridgeInitRouteSchema.safeParse(args.opened)
  let route = parsed.success && !args.refused ? parsed.data : null
  let accepts: readonly string[] = []
  let insets = args.safeAreaInsets ?? ZERO_SAFE_AREA_INSETS
  return {
    current: () => route,
    openIssue: () => (parsed.success ? 'unknown' : (parsed.error.issues[0]?.message ?? 'unknown')),
    readReady: (message) => {
      accepts = message.accepts ?? []
    },
    publish: (next, deliverable) => {
      const update = readBridgeRouteUpdate({ held: route, next, accepts, deliverable })
      if (update.kind === 'refuse') {
        args.onRefused(update.issue)
        return
      }
      route = update.route
      if (update.kind === 'send') {
        args.sendInit()
      }
    },
    safeAreaInsets: () => insets,
    publishSafeAreaInsets: (next, deliverable) => {
      if (sameSafeAreaInsets(insets, next)) {
        return
      }
      insets = next
      // Only to a page that reads them: a re-init to one that does not is a wasted frame per move.
      if (deliverable && accepts.includes(BRIDGE_SAFE_AREA_ACCEPT)) {
        args.sendInit()
      }
    }
  }
}
