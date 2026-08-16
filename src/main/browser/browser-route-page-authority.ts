const MAX_PAGE_ID_LENGTH = 256
const MAX_PAGE_HOST_GENERATION = 0xffff_ffff

export type BrowserRoutePageIdentity = Readonly<{
  partition: string
  browserPageId: string
  pageHostGeneration: number
}>

export type BrowserRoutePageGuestIdentity = BrowserRoutePageIdentity &
  Readonly<{
    webContentsId: number
    rendererWebContentsId: number
  }>

export type BrowserRoutePageAuthorityRetirement = BrowserRoutePageIdentity &
  Readonly<{
    pageAuthority: symbol
    onRetired: () => void
  }>

export function isValidBrowserRoutePageIdentity(value: BrowserRoutePageIdentity): boolean {
  return Boolean(
    value &&
    typeof value.partition === 'string' &&
    typeof value.browserPageId === 'string' &&
    value.browserPageId.length > 0 &&
    value.browserPageId.length <= MAX_PAGE_ID_LENGTH &&
    Number.isInteger(value.pageHostGeneration) &&
    value.pageHostGeneration > 0 &&
    value.pageHostGeneration <= MAX_PAGE_HOST_GENERATION
  )
}

export function browserRoutePageKey(page: BrowserRoutePageIdentity): string {
  return JSON.stringify([page.partition, page.browserPageId, page.pageHostGeneration])
}
