export function isChromiumInternalErrorUrl(url: string): boolean {
  return url.startsWith('chrome-error://')
}

export type PendingMainFrameNavigation = {
  currentUrl: string
  supersededUrls: string[]
}
