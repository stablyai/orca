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

export function shouldShowMarkdownFloatingActions({
  keyboardLift,
  hasStatus,
  showRefresh,
  showCopy,
  showSave
}: {
  keyboardLift: number
  hasStatus: boolean
  showRefresh: boolean
  showCopy: boolean
  showSave: boolean
}): boolean {
  return keyboardLift > 0 || hasStatus || showRefresh || showCopy || showSave
}
