import type { RpcClient } from '../../transport/rpc-client'
import type { RpcSuccess } from '../../transport/types'
import type { BridgeRpcClientDiagnostic } from './bridge-client-diagnostics'
import type { BridgeShellSession } from './bridge-client-session'
import type { BridgeInitRoute } from './bridge-envelope'
import type { BridgeHapticsKind } from './bridge-haptics-notify'
import type { BridgeSafeAreaInsets } from './bridge-safe-area-insets'
import type { PageBackConsumer } from './page-back-consumers'
import type { BridgeNativeVerb } from './bridge-native-verbs'
import type { BridgeClearableRouteParam } from './bridge-route-update'
export type BridgeRpcClientOptions = {
  /** Posts one frame to the shell. May throw; nothing about returning proves delivery. */
  send: (json: string) => void
  onMessage: (handler: (json: string) => void) => () => void
  onDiagnostic?: (diagnostic: BridgeRpcClientDiagnostic) => void
}
export type BridgeRpcClient = RpcClient & {
  /** Fires once `init` has landed, immediately if it already has. Mount no screen before it. */
  onReady: (listener: () => void) => () => void
  /**
   * Fires each time the shell rewrites a param of the screen this page is already on, which is a
   * second `init` for the session it already holds. Never for the first one, and never for a
   * re-sent `init` whose route is the one the page already holds — a re-asked `ready` is answered
   * with that route and is not a request.
   *
   * One delivery per tap rather than one per distinct value: the shell clears the param after each
   * delivery, so a notification tap for the pane already showing arrives as a real move and a
   * listener that deduplicated by value would lose exactly that one.
   */
  onRouteUpdate: (listener: (route: BridgeInitRoute | null) => void) => () => void
  /** Fires when an `init` moved the safe-area insets; the value itself is on `getShellSession`. */
  onSafeAreaInsetsUpdate: (listener: (insets: BridgeSafeAreaInsets) => void) => () => void
  /** Fires when an `init` moved the keyboard height; the value itself is on `getShellSession`. */
  onKeyboardInsetUpdate: (listener: (height: number) => void) => () => void
  onRuntimeRetired?: (listener: (closed: boolean) => void) => () => void
  getShellSession: () => BridgeShellSession | null
  /**
   * Asks the shell to open a screen this page does not render. False when the shell granted no
   * `navigate`, which is an older shell that would refuse the frame outright: the caller then has
   * to do something else, and a thrown error in a tap handler is not that.
   */
  notifyNavigate: (href: string) => boolean
  /**
   * Asks the shell to pop the native stack this page was pushed onto, which is the only stack a
   * document holding one history entry has. False when the shell granted no `navigate`; a shell
   * that granted one but is too old to know this verb refuses the frame instead, and neither is
   * distinguishable from here, so the caller falls back to its own router for both.
   */
  notifyNavigateBack: () => boolean
  /**
   * Asks the shell to open a URL outside the app. False when the shell granted no `externalLink`,
   * or when the URL is not one the grant covers — the caller has to do something else with it, and
   * a throw inside a tap handler is not that.
   */
  notifyExternalLink: (url: string) => boolean
  /**
   * Calls one shell-answered verb. It rides the same `request` frame, id space and in-flight cap
   * as a desktop method; the `native.` prefix is what makes the host answer it instead of
   * forwarding. It lives here rather than in a screen because that is what keeps the raw request
   * port inside the module that owns it — a native verb is bridge machinery, not an RPC to a
   * runtime, so it has no `RpcOperation` and no entry in the desktop's method catalog.
   */
  callNativeVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<RpcSuccess>
  /**
   * Tells the shell this document has a frame on screen, which is the only thing that does: the
   * shell sees a document commit and a page say `ready`, and neither of those is a painted tree.
   */
  notifyPagePainted: () => void
  /**
   * Claims the device Back key for this document until the dispose is called.
   *
   * The shell owns the key and only hands a press over while something here is holding it, so a
   * claim is what turns Android Back from "leave this screen" into "close what is on top of it".
   * Consumers answer newest first and a `false` falls through, exactly as a native `BackHandler`
   * listener does; a press nothing takes is handed back to the shell to pop with.
   */
  claimBack: (consumer: PageBackConsumer) => () => void
  /** Writes one allowlisted key into the app's store. False when the shell granted no `storage`. */
  notifyStorageWrite: (key: string, value: string | null) => boolean
  /**
   * Asks the shell to play one haptic. False when the shell granted no `haptics`, which no caller
   * has to do anything about: a tap that did not buzz is what the page did before this existed.
   */
  notifyHaptics: (kind: BridgeHapticsKind) => boolean
  /**
   * Tells the shell this page cannot render what it was opened for. Never throws and never rejects:
   * the one caller is an error boundary, and a report that threw would be the second failure.
   *
   * False means nothing left — no session, a closed client, a shell that granted no fault
   * reporting, or a port that refused the frame. There is no second attempt: what could not be said
   * once will not say itself on a retry, and the shell's own load state is the other way it finds out.
   */
  notifyPageFault: (error: unknown) => boolean
  /**
   * Erases a one-shot route param the shell handed this page, naming the value the page applied
   * (ruling 34). The reader erases: the shell tracks no delivery, so a request stays on the route
   * and keeps arriving until the page that applied it says so.
   *
   * False when the frame could not leave. Nothing is owed the caller — a clear that did not leave
   * is repaired by the request arriving again, which is the same path a lost frame takes.
   */
  clearRouteParam: (param: BridgeClearableRouteParam, value: string) => boolean
}
