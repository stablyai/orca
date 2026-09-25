const MAX_PAGE_ID_LENGTH = 256
const MAX_PAGE_HOST_GENERATION = 0xffff_ffff

export type BrowserRoutePageIdentity = Readonly<{
  partition: string
  browserPageId: string
  pageHostGeneration: number
}>

export type BrowserRoutePageOwnerIdentity = BrowserRoutePageIdentity &
  Readonly<{
    rendererWebContentsId: number
  }>

export type BrowserRoutePageGuestIdentity = BrowserRoutePageOwnerIdentity &
  Readonly<{
    webContentsId: number
  }>

export type BrowserRouteGuestLifecycleClaim = Readonly<{
  registration: BrowserRoutePageGuestIdentity
  guestAuthority: symbol
  whenDestroyed: Promise<void>
  isCurrent: () => boolean
}>

export type BrowserRoutePageAuthority = BrowserRoutePageOwnerIdentity &
  Readonly<{
    pageAuthority: symbol
  }>

export type BrowserRoutePageAuthorityRetirement = BrowserRoutePageAuthority &
  Readonly<{
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

export function isValidBrowserRoutePageOwnerIdentity(
  value: BrowserRoutePageOwnerIdentity
): boolean {
  return Boolean(
    isValidBrowserRoutePageIdentity(value) &&
    Number.isInteger(value.rendererWebContentsId) &&
    value.rendererWebContentsId > 0
  )
}

export function browserRoutePageKey(page: BrowserRoutePageIdentity): string {
  return JSON.stringify([page.partition, page.browserPageId, page.pageHostGeneration])
}

export function browserRouteLogicalPageKey(
  browserPageId: string,
  pageHostGeneration: number
): string {
  return JSON.stringify([browserPageId, pageHostGeneration])
}
