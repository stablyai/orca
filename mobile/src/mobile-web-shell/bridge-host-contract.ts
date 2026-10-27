import type { TerminalBacklogEnd, TerminalBacklogTimers } from './bridge-terminal-output-backlog'
import type { RpcClient } from '../transport/rpc-client'
import type { BridgeSessionBack } from './bridge-host-back'
import type { BridgeRefusal } from './bridge/bridge-caps'
import type { BridgeColorScheme, BridgeInitHost, BridgeInitRoute } from './bridge/bridge-envelope'
import type { BridgeClearableRouteParam } from './bridge/bridge-route-update'
import type { BridgeSafeAreaInsets } from './bridge/bridge-safe-area-insets'
import type { BridgeHapticsKind } from './bridge/bridge-haptics-notify'
import type { BridgeErrorCapture } from './bridge/bridge-error-capture'
import type { BridgeNativeVerb } from './bridge/bridge-native-verbs'
import type { BridgeNotifyRefusal } from './bridge/bridge-notify-grants'
import type { PageStorageForInit } from './page-storage-keys'

// Only popped moves the stack; nothing-to-pop means root entry, while pop-pending means a duplicate frame before the queued pop commits.
export type BridgeNavigateBackOutcome = 'popped' | 'nothing-to-pop' | 'pop-pending'

export type BridgeHostDiagnostic =
  | { kind: 'refused'; refusal: BridgeRefusal }
  | { kind: 'post-failed'; error: unknown }
  // Only a leaked view can post after host disposal; log rather than silently hide it.
  | { kind: 'frame-after-dispose' }
  // Notify owes no reply; report forwarding-listener failures locally.
  | { kind: 'notify-failed'; error: unknown }
  // Refuse old-document frames between close and ready; answering could leak them into the next document.
  | { kind: 'frame-after-close' }
  | { kind: 'storage-refused'; key: string }
  // Log and drop notify names not granted to an established session; no reply is owed.
  | { kind: 'notify-refused'; name: string; why: BridgeNotifyRefusal }
  // Back notify has no reply, so log why the native stack did not pop.
  | { kind: 'navigate-back-refused'; why: Exclude<BridgeNavigateBackOutcome, 'popped'> }
  // Serve no session for a protocol-invalid route; sending an init the page rejects would leave it blank.
  | { kind: 'route-refused'; issue: string }
  // Refuse invalid or different-screen route updates locally; no frame reaches the page.
  | { kind: 'route-update-refused'; issue: string }
  // Without the binary grant, subscriptions still carry JSON; this local diagnostic alone explains the refused binary lane.
  | { kind: 'binary-lane-refused'; id: string }
  // Drop oversized/window-exceeding screencast frames without ending the stream; log full event bytes and cumulative loss as the only evidence.
  | { kind: 'binary-frame-dropped'; id: string; bytes: number; dropped: number }
  // Report held-output metrics when a terminal retires; only this local ended distinguishes causes that both cross the wire as overflow.
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
  // Resolution proves native handoff, never page receipt; reject when no view can accept it.
  post: (json: string) => Promise<void>
  buildId: string
  sessionId: string
  // Required locally but optional on the wire for older shells that send no route.
  route: BridgeInitRoute
  pageRoutes: readonly string[]
  // Keep hops local only if this session covers the target’s manifest grants; absent entries retain the page’s older routing rule.
  pageRouteGrants?: readonly { pathname: string; grants: readonly string[] }[]
  // Grant only this route’s implemented capabilities plus protocol fault; another route’s clipboard grant must not widen this session.
  routeGrants: readonly string[]
  ownsHostArea?: boolean
  // Inherit handshake state on client-driven rebuild: the session id/page do not change, so no new ready or BridgeShellReplaced arrives.
  sessionEstablished: boolean
  // Inherit the live Back claim alongside handshake state; the page is never told to re-claim after client replacement.
  sessionBack?: BridgeSessionBack
  host: BridgeInitHost
  // Default to zero; publishSafeAreaInsets moves system-bar coverage later.
  safeAreaInsets?: BridgeSafeAreaInsets
  // Default to zero; publishKeyboardInset moves native keyboard height later.
  keyboardInset?: number
  // Default to dark; publishColorScheme moves the app's resolved scheme later.
  colorScheme?: BridgeColorScheme
  // Read identity at forward time because this host outlives renders; replace the page placeholder as init promised or the desktop refuses spoofed sends.
  readClientIdentity: () => string | null
  // Read allowlisted storage synchronously for every init so document reloads include writes made since mount.
  readStorage: () => PageStorageForInit
  onStorageWrite: (key: string, value: string | null) => void
  // Required to honor navigate grants: open targets the page cannot render, replacing this screen when asked.
  onNavigate: (href: string, replace: boolean) => void
  // Serve native verbs only on-device; rejection becomes the page’s request error and never reaches the desktop.
  serveNativeVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
  // The envelope already checked URL schemes. Never throw from native frame handling; report device-open failure locally because notify has no reply.
  onExternalLink: (url: string) => void
  // Inject device haptics to keep react-native/expo-haptics out of the protocol module; never throw from native frame handling.
  onHaptic: (kind: BridgeHapticsKind) => void
  // Honor navigate’s Back on the native stack; return the refusal reason for diagnostics because the page gets no reply.
  onNavigateBack: () => BridgeNavigateBackOutcome
  // Required recovery: hash-checked disk bytes will fail again until the shell stops showing the broken generation.
  onPageFault: (error: BridgeErrorCapture) => void
  // Ready is proof the bundle evaluated; the shell uses it to bound startup instead of waiting forever.
  onPageReady: () => void
  onPagePainted: () => void
  // Required for native interception: only a live claim owns Back. Document-ending paths publish false so callers need not infer staleness.
  onPageBackClaim: (claimed: boolean) => void
  // Where a host-area page navigated inside its own document; the native route never moves for those hops.
  onPageLocation: (href: string) => void
  // Clear a consumed one-shot param only if its value still matches; a newer tap may already have replaced it (ruling 34).
  onRouteParamClear: (param: BridgeClearableRouteParam, value: string) => void
  // Escalate invalid shell routes visibly; a page-only console warning would leave a blank document retrying forever.
  onRouteRefused: (issue: string) => void
  onDiagnostic?: (diagnostic: BridgeHostDiagnostic) => void
  // Publish cumulative frame loss; once-per-host diagnostics cannot distinguish one dropped frame from ongoing loss.
  onBinaryFramesDropped?: (total: number) => void
  // Inject timers for tests so they exercise the shipped silence bound without waiting twenty seconds per case.
  terminalTimers?: TerminalBacklogTimers
}
