// The one rule for where a dictation's controls live: in place on its session screen, or the floating pill.
// Today the session screen counts as showing its dictation whenever it is in front, on any of its tabs; the
// words still land in the tab where the dictation started. Showing the pill on another tab too means adding
// "and the dictation's target tab is the active one" here.
export function mobileDictationShownOnScreen({
  ownedHere,
  inFront
}: {
  // This screen shows the session the dictation was started in.
  ownedHere: boolean
  // This screen is the one in front (no other screen pushed over it).
  inFront: boolean
}): boolean {
  return ownedHere && inFront
}
