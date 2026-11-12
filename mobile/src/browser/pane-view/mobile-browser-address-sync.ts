export type MobileBrowserAddressSyncState = {
  focused: boolean
  url: string
}

export type MobileBrowserAddressSyncResult = {
  nextState: MobileBrowserAddressSyncState
  shouldSyncValue: boolean
}

export function resolveMobileBrowserAddressSync(
  previous: MobileBrowserAddressSyncState,
  next: MobileBrowserAddressSyncState
): MobileBrowserAddressSyncResult {
  const changed = previous.focused !== next.focused || previous.url !== next.url
  return {
    nextState: changed ? next : previous,
    shouldSyncValue: changed && !next.focused
  }
}
