import {
  BridgeInitRouteSchema,
  type BridgeColorScheme,
  type BridgeInitRoute,
  type BridgeUiLocale
} from './bridge/bridge-envelope'
import { readBridgeRouteUpdate } from './bridge/bridge-route-update'
import {
  sameSafeAreaInsets,
  ZERO_SAFE_AREA_INSETS,
  type BridgeSafeAreaInsets
} from './bridge/bridge-safe-area-insets'

export type BridgeHostRoute = {
  readonly current: () => BridgeInitRoute | null
  readonly openIssue: () => string
  // Hold the newest same-screen route even if posting fails; the next document’s ready repairs delivery. Track no receipt; the page consumes/clears its own one-shot params (ruling 34).
  readonly publish: (next: BridgeInitRoute, deliverable: boolean) => void
  readonly safeAreaInsets: () => BridgeSafeAreaInsets
  // Hold changed insets even when posting fails so the next ready carries them.
  readonly publishSafeAreaInsets: (next: BridgeSafeAreaInsets, deliverable: boolean) => void
  readonly keyboardInset: () => number
  readonly publishKeyboardInset: (next: number, deliverable: boolean) => void
  readonly colorScheme: () => BridgeColorScheme
  readonly publishColorScheme: (next: BridgeColorScheme, deliverable: boolean) => void
  readonly uiLocale: () => BridgeUiLocale | undefined
  readonly publishUiLocale: (next: BridgeUiLocale, deliverable: boolean) => void
}

// Parse against the page’s route schema before init; interpolated host ids with query/hash/whitespace/dot segments could otherwise leave a blank page asking forever.
// Only publish changes the held route; delivery is not tracked, and different-screen navigation remounts the shell (rulings 33.1/34).
export function createBridgeHostRoute(args: {
  opened: BridgeInitRoute
  refused: boolean
  sendInit: () => void
  onRefused: (issue: string) => void
  safeAreaInsets?: BridgeSafeAreaInsets
  keyboardInset?: number
  colorScheme?: BridgeColorScheme
  uiLocale?: BridgeUiLocale
}): BridgeHostRoute {
  const parsed = BridgeInitRouteSchema.safeParse(args.opened)
  let route = parsed.success && !args.refused ? parsed.data : null
  let insets = args.safeAreaInsets ?? ZERO_SAFE_AREA_INSETS
  let keyboard = args.keyboardInset ?? 0
  let scheme = args.colorScheme ?? 'dark'
  let uiLocale = args.uiLocale
  return {
    current: () => route,
    openIssue: () => (parsed.success ? 'unknown' : (parsed.error.issues[0]?.message ?? 'unknown')),
    publish: (next, deliverable) => {
      const update = readBridgeRouteUpdate({ held: route, next, deliverable })
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
      if (deliverable) {
        args.sendInit()
      }
    },
    keyboardInset: () => keyboard,
    publishKeyboardInset: (next, deliverable) => {
      if (keyboard === next) {
        return
      }
      keyboard = next
      if (deliverable) {
        args.sendInit()
      }
    },
    colorScheme: () => scheme,
    publishColorScheme: (next, deliverable) => {
      if (scheme === next) {
        return
      }
      scheme = next
      if (deliverable) {
        args.sendInit()
      }
    },
    uiLocale: () => uiLocale,
    publishUiLocale: (next, deliverable) => {
      if (uiLocale === next) {
        return
      }
      uiLocale = next
      if (deliverable) {
        args.sendInit()
      }
    }
  }
}
