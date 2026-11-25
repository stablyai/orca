export const MAX_BROWSER_PAGE_GENERATION = 0xffff_ffff

const MAX_IDENTITY_LENGTH = 256

export type BrowserHostPlacementIdentity = Readonly<{
  browserHostClientId: string
  browserHostGeneration: number
}>

export function assertBrowserPageIdentity(browserPageId: string): void {
  if (
    typeof browserPageId !== 'string' ||
    browserPageId.length === 0 ||
    browserPageId.length > MAX_IDENTITY_LENGTH
  ) {
    throw new Error('browser_page_identity_invalid')
  }
}

export function assertBrowserPageGeneration(pageHostGeneration: number): void {
  if (
    !Number.isInteger(pageHostGeneration) ||
    pageHostGeneration < 1 ||
    pageHostGeneration > MAX_BROWSER_PAGE_GENERATION
  ) {
    throw new Error('browser_page_generation_stale')
  }
}

export function assertBrowserHostPlacementIdentity(host: BrowserHostPlacementIdentity): void {
  if (
    typeof host.browserHostClientId !== 'string' ||
    host.browserHostClientId.length === 0 ||
    host.browserHostClientId.length > MAX_IDENTITY_LENGTH ||
    !Number.isInteger(host.browserHostGeneration) ||
    host.browserHostGeneration < 1 ||
    host.browserHostGeneration > MAX_BROWSER_PAGE_GENERATION
  ) {
    throw new Error('browser_host_identity_invalid')
  }
}
