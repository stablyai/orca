import type { BrowserClientPageRenderer } from '../renderer/browser-client-page-renderer-contract'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'

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
