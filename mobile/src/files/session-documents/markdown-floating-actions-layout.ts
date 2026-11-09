export function resolveMarkdownFloatingActionsBottom({
  keyboardLift,
  restingBottom,
  liftedClearance
}: {
  keyboardLift: number
  restingBottom: number
  liftedClearance: number
}): number {
  return keyboardLift > 0 ? keyboardLift + liftedClearance : restingBottom
}
