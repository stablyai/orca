import type { TerminalBacklogEnd, TerminalBacklogTimers } from './bridge-terminal-output-backlog'
import type { RpcClient } from '../transport/rpc-client'
import type { BridgeSessionBack } from './bridge-host-back'
import type { BridgeRefusal } from './bridge/bridge-caps'
import type { BridgeInitHost, BridgeInitRoute } from './bridge/bridge-envelope'
import type { BridgeClearableRouteParam } from './bridge/bridge-route-update'
import type { BridgeSafeAreaInsets } from './bridge/bridge-safe-area-insets'
import type { PageReadyDeclaration } from './mobile-web-shell-session-contract'
import type { BridgeHapticsKind } from './bridge/bridge-haptics-notify'
import type { BridgeErrorCapture } from './bridge/bridge-error-capture'
import type { BridgeNativeVerb } from './bridge/bridge-native-verbs'
import type { BridgeNotifyRefusal } from './bridge/bridge-notify-grants'
import type { PageStorageForInit } from './page-storage-keys'

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
  /** A rewritten route this host would not hand its page: a different screen, or a shape the
   *  page's own reader would refuse. Local only — nothing crosses, and the tap it came from is
   *  then the lost repeat tap it was before ruling 33.1. */
  | { kind: 'route-update-refused'; issue: string }
  /** A page subscribed with `wantsBinary` on a session whose route was never granted the lane.
   *  Local only: the subscription proceeds and its JSON events cross, so nothing crosses back and
   *  this line is the only thing that can say why the frames never became binary. */
  | { kind: 'binary-lane-refused'; id: string }
  /** A screencast frame that would not fit the envelope or the stream's unacked window. Dropped
   *  rather than ending the stream, so this line and the count beside it are the only evidence
   *  the frame existed. `bytes` is the whole event, which is what was measured against the cap. */
  | { kind: 'binary-frame-dropped'; id: string; bytes: number; dropped: number }
  /**
   * What one terminal stream's held output did, once the stream is retired.
   *
   * The only oracle there is for the coalescing rule: nothing crosses to the page saying how much
   * was held or how many frames its bytes arrived inside, and `ended` is the only place the two
   * ways a held stream dies are told apart — both reach the page as `overflow`, because a reason
   * the page's reader has never heard of is a frame it drops.
   */
  | {
      kind: 'terminal-backlog'
      id: string
      coalescedFrames: number
      deliveredFrames: number
      peakPendingBytes: number
      ended: TerminalBacklogEnd | null
    }

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
   * What each of those patterns declared, from the manifest this shell already holds.
   *
   * The page decides an in-page hop with it: a push is kept local only when the target's grants are
   * covered by this session's. Optional, because a shell with no manifest entry for a pattern has
   * nothing to say about it and the page then keeps its old rule.
   */
  pageRouteGrants?: readonly { pathname: string; grants: readonly string[] }[]
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
  /**
   * What the session already established about the device Back key, when this host is a rebuild
   * taking one over. Absent for a host opening a session of its own.
   *
   * The sibling of `sessionEstablished`, and for the same reason: the page is never told that its
   * client was swapped, so what it declared and what it is holding are facts about the session
   * rather than about this object. A host that relearned them would refuse every press until the
   * page happened to speak again.
   */
  sessionBack?: BridgeSessionBack
  /** The host the page is showing, minus the credential the bridge already carries for it. */
  host: BridgeInitHost
  /** How much of the WebView sits under a system bar when it is drawn edge-to-edge. Zeros when
   *  absent; moved later with `publishSafeAreaInsets`. */
  safeAreaInsets?: BridgeSafeAreaInsets
  /**
   * This device's identity to that host, as the native screens already send it, swapped in for the
   * page's placeholder on the way out. Read at forward time rather than captured: the host outlives
   * every render after the one that built it. Required, because `init` tells the page the swap
   * happens and a page that believed it and was not served would have its sends refused as spoofs.
   */
  readClientIdentity: () => string | null
  /**
   * The allowlisted keys as the app holds them, asked for on every `init` rather than captured at
   * mount: a document that reloads inside one mount has to be primed from after its own writes.
   * Synchronous, because `init` is — see `sendInit`.
   */
  readStorage: () => PageStorageForInit
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
   * Plays one haptic on this device. Required for the reason `onExternalLink` is: the `haptics`
   * grant is issued on the strength of this existing.
   *
   * Injected rather than called here, as every other device-local notify is: a static import of the
   * app's haptics would put `react-native` and `expo-haptics` in this module's graph, and the host
   * is the protocol's half of the bridge on either. It must not throw — this runs on the native
   * frame handler — and it owes the page nothing, which is why a notify rather than a verb.
   */
  onHaptic: (kind: BridgeHapticsKind) => void
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
  onPageReady: (ready: PageReadyDeclaration) => void
  /**
   * The page has a frame on screen. Only pages whose `ready` listed `BRIDGE_PAGE_PAINTED` post it,
   * which is why `onPageReady` carries that list: a caller covering the view until this arrives
   * has to know whether it is coming, and a page served from an older desktop never sends one.
   */
  onPagePainted: () => void
  /**
   * The page is holding the device Back key, or has let it go. Required, because the shell only
   * intercepts the key while a claim is live and a host built without this would leave the claim
   * unreadable — a page holding one would have Back pop the screen out from under its sheet.
   *
   * False arrives on its own for every way a document ends, so a caller never has to guess whether
   * a claim outlived the page that made it.
   */
  onPageBackClaim: (claimed: boolean) => void
  /**
   * The page applied a one-shot route param and is asking for it to be erased (ruling 34), naming
   * the value it applied. The holder of that param compares before it clears: a tap that has moved
   * on since leaves a newer value here, and a clear naming the older one is not for it.
   */
  onRouteParamClear: (param: BridgeClearableRouteParam, value: string) => void
  /**
   * The route this shell was built with is not one the protocol allows, so no honest `init` can be
   * sent and the page will never mount. Loud on purpose: the page's own refusal is a `console.warn`
   * inside a WebView nobody is reading, and the alternative is a blank screen that retries forever.
   */
  onRouteRefused: (issue: string) => void
  onDiagnostic?: (diagnostic: BridgeHostDiagnostic) => void
  /**
   * Every screencast frame this host has dropped, after each one.
   *
   * A total and not an event, because what reads it is a surface that shows a number: the
   * diagnostic beside it is held to one line per host, so without this a stream losing a frame a
   * second and a stream that lost one look the same.
   */
  onBinaryFramesDropped?: (total: number) => void
  /**
   * The timer a held terminal stream arms for the page's silence, injected only by tests.
   *
   * A real shell uses `setTimeout`; a test that waited the silence bound out would be twenty
   * seconds long per case, and one that shortened the constant would be checking a number nothing
   * ships.
   */
  terminalTimers?: TerminalBacklogTimers
}
