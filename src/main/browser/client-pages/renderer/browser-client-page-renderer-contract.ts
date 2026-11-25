import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientPageRendererIdentity } from '../../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'

export type BrowserClientPageRenderer = {
  rendererWebContentsId: number
  isCurrent(): boolean
  mountPage(
    page: Readonly<BrowserClientPageRendererIdentity>,
    signal: AbortSignal
  ): Promise<{ webContentsId: number }>
  rekeyPage?(
    previous: Readonly<BrowserClientPageRendererIdentity>,
    next: Readonly<BrowserClientPageRendererIdentity>,
    signal: AbortSignal
  ): Promise<void>
  retirePage(page: Readonly<BrowserClientPageRendererIdentity>): void | Promise<void>
}

export function browserClientPageIdentity(
  page: Pick<BrowserClientHostCommandEvent, 'browserPageId' | 'pageHostGeneration'>,
  partition: string
): Readonly<BrowserClientPageRendererIdentity> {
  return {
    partition,
    browserPageId: page.browserPageId,
    pageHostGeneration: page.pageHostGeneration
  }
}
