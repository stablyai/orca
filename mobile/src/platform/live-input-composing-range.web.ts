/**
 * Web sibling: the event is the DOM's, so its `isComposing` passes through except in an Android
 * WebView, which reports none, as native Android does.
 */
export function reportedLiveInputComposing(isComposing: boolean | undefined): boolean | undefined {
  // Why: Android keyboards compose every Latin word, so the DOM's range would hold each one unsent.
  if (globalThis.navigator?.userAgent?.includes('Android')) {
    return undefined
  }
  return isComposing
}
