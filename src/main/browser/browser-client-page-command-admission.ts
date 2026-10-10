import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import type {
  BrowserClientPageRenderer,
  BrowserClientPageRendererIdentity
} from './browser-client-page-cleanup'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'

export function browserClientPageIdentity(
  page: Pick<BrowserClientHostCommandEvent, 'browserPageId' | 'pageHostGeneration'>,
  partition: string
): BrowserClientPageRendererIdentity {
  return {
    partition,
    browserPageId: page.browserPageId,
    pageHostGeneration: page.pageHostGeneration
  }
}

export function assertCurrentBrowserClientPageRenderer(renderer: BrowserClientPageRenderer): void {
  if (
    !Number.isInteger(renderer.rendererWebContentsId) ||
    renderer.rendererWebContentsId <= 0 ||
    !renderer.isCurrent()
  ) {
    throw new BrowserClientPageCommandError('browser_client_page_renderer_stale')
  }
}

export function assertBrowserClientPageCommandNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BrowserClientPageCommandError('browser_client_page_command_aborted')
  }
}
