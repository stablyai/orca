import type { RpcClient } from '../transport/rpc-client'
import type { BridgeRefusal } from './bridge/bridge-caps'
import type { BridgeInitHost, BridgeInitRoute } from './bridge/bridge-envelope'
import type { BridgeErrorCapture } from './bridge/bridge-error-capture'
import type { BridgeNativeVerb } from './bridge/bridge-native-verbs'
import type { BridgeNotifyRefusal } from './bridge/bridge-notify-grants'

/**
 * What the shell did with a `navigate-back`. Only `popped` moved the stack, and the other two are
 * different faults: nothing to pop is a page opened as the first screen, a pending pop is a second
 * frame arriving in the batch that queued the first.
 */
export type BridgeNavigateBackOutcome = 'popped' | 'nothing-to-pop' | 'pop-pending'

/** What a caller owes one bridge host, and everything it will be told back.
 *  Separate from the host itself so the shape of the contract reads without the machinery. */

/** Nothing here is recoverable in place; each is worth a line in a log and none of them is retried. */
export type BridgeHostDiagnostic =
  | { kind: 'refused'; refusal: BridgeRefusal }
  | { kind: 'post-failed'; error: unknown }
  /** A page posting into a host that has already been disposed, which its own view is the only
   *  thing that can do. Dropping it silently is what hides a leaked view. */
  | { kind: 'frame-after-dispose' }
  /** A listener that threw where the bridge only forwards. Nothing is owed to the page for a
   *  notify, so the throw is reported rather than answered. */
  | { kind: 'notify-failed'; error: unknown }
  /** A frame that arrived between a page's `close` and the next document's `ready`. It belongs to
   *  the closed document, and serving it would answer into whatever loads in next. */
  | { kind: 'frame-after-close' }
  /** A write for a key this page was never handed: another host's pinned list. */
  | { kind: 'storage-refused'; key: string }
  /** A `notify` the host will not act on: a grant-gated name it never issued, or any name from a
   *  page that has not asked for a session yet. Nothing is owed back, so it is logged and dropped. */
  | { kind: 'notify-refused'; name: string; why: BridgeNotifyRefusal }
  /** A `navigate-back` the shell did not act on, and which of the two reasons it was. Logged
   *  because the page is told nothing either way, so silence here is indistinguishable from a pop
   *  that worked. */
  | { kind: 'navigate-back-refused'; why: Exclude<BridgeNavigateBackOutcome, 'popped'> }
  /** The shell asked this host to open a screen the protocol does not allow. The host serves no
   *  session at all in that state: an `init` the page refuses is worse than no `init`. */
  | { kind: 'route-refused'; issue: string }

export type BridgeHostOptions = {
  client: RpcClient
  /**
   * Rejects when there is nowhere to post. Resolving proves the message was handed over, never that
   * the page received it, so nothing here treats a resolve as an acknowledgement.
   */
  post: (json: string) => Promise<void>
  buildId: string
  sessionId: string
  /**
   * Which screen the page should open. Required of a caller in this build and optional on the wire:
   * an older shell sends no route at all, and the page has a state for that which nothing here can
   * reach.
   */
  route: BridgeInitRoute
  /** Every route pattern the shell would render from the page, so the page knows what to keep. */
  pageRoutes: readonly string[]
  /**
   * What the route this session was opened for declared, narrowed to what this shell implements.
   *
   * This is the session's whole capability, not the app's: `init` grants exactly these plus the
   * protocol's own `fault`, and every grant check reads the same list. A route asking for
   * navigation does not get the clipboard because some other route needs it.
   */
  routeGrants: readonly string[]
  /**
   * Whether this session already completed a handshake before this host existed.
   *
   * A host is rebuilt when the client under it changes, and the page on the other side does not
   * know: the session id is the same, so it neither re-handshakes nor hears `BridgeShellReplaced`.
   * The pre-handshake refusal is about the session, not this object, so a rebuilt host inherits
   * what the session already established and serves it.
   */
  sessionEstablished: boolean
  /** The host the page is showing, minus the credential the bridge already carries for it. */
  host: BridgeInitHost
  /**
   * The allowlisted keys as the app holds them, asked for on every `init` rather than captured at
   * mount: a document that reloads inside one mount has to be primed from after its own writes.
   * Synchronous, because `init` is — see `sendInit`.
   */
  readStorage: () => Readonly<Record<string, string>>
  /** One allowlisted key written, or removed when the value is null. */
  onStorageWrite: (key: string, value: string | null) => void
  /**
   * Opens a screen the page does not render. Required, because `init` grants `navigate` on the
   * strength of this existing: a page told it may hand a route back and then handed one back into
   * nothing is a dead tap, which is exactly what the grant is supposed to rule out.
   */
  onNavigate: (href: string) => void
  /**
   * Serves one `native.` verb on this device. Required, because the grant list advertises the verbs
   * and a page told it may call one that reaches nothing is the dead tap the grants rule out.
   *
   * Rejecting is the refusal: the host turns it into an error frame the page's request rejects
   * with. Nothing here reaches the desktop.
   */
  serveNativeVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
  /**
   * Opens a URL outside the app, which is the whole of the `externalLink` grant. Required for the
   * reason `onNavigate` is: the grant is issued on the strength of this existing.
   *
   * The URL has already been held to the allowed schemes by the envelope, so a caller is handed
   * one it may open. It must not throw — this runs on the native frame handler — and it must
   * report a URL it could not open: nothing crosses back to the page for a notify, so an open that
   * failed is invisible on both sides unless the caller says so.
   */
  onExternalLink: (url: string) => void
  /**
   * Pops the native stack this page was pushed onto. Required for the reason `onNavigate` is: the
   * `navigate` grant carries this verb too, and a page told it may hand its Back button over and
   * then handed it into nothing is the dead tap the grant exists to rule out.
   *
   * The outcome is the shell's answer and not the page's business — nothing crosses back either
   * way — but it is what the diagnostic names, so it has to say which refusal this was.
   */
  onNavigateBack: () => BridgeNavigateBackOutcome
  /**
   * The page could not render the generation it was handed. Required, because the page has no
   * recovery of its own: the generation is on disk and was hash-checked before the view loaded it,
   * so the same bytes throw again, and the only thing left is for the shell to stop showing them.
   */
  onPageFault: (error: BridgeErrorCapture) => void
  /**
   * The page asked for a session, which is the only proof its bundle evaluated at all. Required for
   * the same reason as the fault: the shell bounds the wait for it, and a host built without this
   * would leave a document that never spoke looking exactly like one still starting up.
   */
  onPageReady: () => void
  /**
   * The route this shell was built with is not one the protocol allows, so no honest `init` can be
   * sent and the page will never mount. Loud on purpose: the page's own refusal is a `console.warn`
   * inside a WebView nobody is reading, and the alternative is a blank screen that retries forever.
   */
  onRouteRefused: (issue: string) => void
  onDiagnostic?: (diagnostic: BridgeHostDiagnostic) => void
}
