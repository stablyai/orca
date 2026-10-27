export function reportedLiveInputComposing(isComposing: boolean | undefined): boolean | undefined {
  // Android keyboards compose every Latin word; forwarding that DOM range would hold each word unsent.
  if (globalThis.navigator?.userAgent?.includes('Android')) {
    return undefined
  }
  return isComposing
}
