import { spacing } from '../theme/mobile-theme'

/** The terminal command dock's bottom padding for the current keyboard state. */
export function commandDockBottomPadding(bottomInset: number, keyboardLift: number): number {
  // Why: at rest the shortcut row would otherwise sit on the rounded screen corners; once the
  // keyboard lifts the dock, the same clearance would only widen the gap above the keyboard.
  return bottomInset + (keyboardLift > 0 ? 0 : spacing.sm)
}
