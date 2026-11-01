import {
  triggerEdgeBump,
  triggerError,
  triggerMediumImpact,
  triggerSelection,
  triggerSuccess
} from '../platform/haptics'
import type { BridgeHapticsKind } from './bridge/bridge-haptics-notify'

// Reuse native functions so platform styles stay identical. The typed table covers every bridge kind; the platform-seams haptics census checks new native functions also get a kind.
const HAPTIC_BY_KIND: Readonly<Record<BridgeHapticsKind, () => void>> = {
  mediumImpact: triggerMediumImpact,
  selection: triggerSelection,
  success: triggerSuccess,
  error: triggerError,
  edgeBump: triggerEdgeBump
}

// No acknowledgement needed: native functions already catch device refusals.
export function playPageHaptic(kind: BridgeHapticsKind): void {
  HAPTIC_BY_KIND[kind]()
}
