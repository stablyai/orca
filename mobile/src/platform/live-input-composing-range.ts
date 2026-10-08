/**
 * The marked-text range a live input's change event reports, as the host's text system means it.
 * Native passes the event's own through: iOS reports its range, React Native Android reports none.
 */
export function reportedLiveInputComposing(isComposing: boolean | undefined): boolean | undefined {
  return isComposing
}
