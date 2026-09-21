import {
  triggerEdgeBump,
  triggerError,
  triggerMediumImpact,
  triggerSelection,
  triggerSuccess
} from '../platform/haptics'
import type { BridgeHapticsKind } from './bridge/bridge-haptics-notify'

/**
 * A haptic the page asked for, played by the same functions a native screen plays.
 *
 * The native file's own bodies and nothing beside them: the `Platform.OS` split, the Android
 * `HapticFeedbackConstants` and the iOS styles all stay where they are, so a phone feels the same
 * tap whether the screen came from the bundle or from the app. A second mapping would be the one
 * that drifted.
 *
 * Total in both the directions a type can state. Keyed on the kind union, a kind with no row does
 * not compile; named as imports rather than reached through a namespace, a row naming a function
 * `haptics.ts` does not export does not compile either. The third direction — a haptic that file
 * grows with no kind of its own, which the page could never ask for — is the census's, in
 * `config/scripts/mobile-web-app-haptics-seam.test.mjs`, which reads both files' names.
 */
const HAPTIC_BY_KIND: Readonly<Record<BridgeHapticsKind, () => void>> = {
  mediumImpact: triggerMediumImpact,
  selection: triggerSelection,
  success: triggerSuccess,
  error: triggerError,
  edgeBump: triggerEdgeBump
}

/** Nothing is owed back: every function above is already `void …catch(() => {})` on the device. */
export function playPageHaptic(kind: BridgeHapticsKind): void {
  HAPTIC_BY_KIND[kind]()
}
