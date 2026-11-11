import { rendererPublicationThrottle } from '../../window/renderer-publication-throttle'

export type History = { entries: { url: string; title: string }[]; index: number }
export type Claim = { held: boolean; operations: number; pendingRendererId?: number }
export type Page = {
  generation: number
  rendererId: number
  partition: string
  guest: Electron.WebContents | null
  claim: Claim
  releaseThrottle: (() => void) | null
  history: History | null
  restoring: Promise<void> | null
  retired: Map<number, { guest: Electron.WebContents; rendererId: number }>
  token: string | null
}
export const claims = new Map<string, Claim>()
export const pages = new Map<string, Page>()
export const retiredGuests = new Map<
  number,
  { pageId: string; rendererId: number; guest: Electron.WebContents }
>()

export function renewHeldThrottle(page: Page): void {
  if (page.claim.held && page.guest && !page.guest.isDestroyed() && !page.releaseThrottle) {
    page.releaseThrottle = rendererPublicationThrottle.acquire(page.guest)
  }
}
