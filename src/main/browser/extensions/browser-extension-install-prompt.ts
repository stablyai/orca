import { randomUUID } from 'node:crypto'
import {
  BROWSER_EXTENSION_INSTALL_PROMPT_CLOSED_CHANNEL,
  BROWSER_EXTENSION_INSTALL_PROMPT_REQUESTED_CHANNEL,
  type BrowserExtensionInstallPromptRequest,
  type BrowserExtensionInstallPromptResponse
} from '../../../shared/browser-extension-webstore'

/** Main → renderer round trip for Orca's install/uninstall confirmation (mirrors the passkey picker). */

export const BROWSER_EXTENSION_INSTALL_PROMPT_TIMEOUT_MS = 5 * 60_000

type PendingPrompt = {
  renderer: Electron.WebContents
  settle: (accepted: boolean) => void
}

const pendingPrompts = new Map<string, PendingPrompt>()

/**
 * Resolves true only when the user accepts. Declines on timeout, or when the renderer or the page
 * that asked (`guest`) goes away or navigates to another document.
 */
export function requestBrowserExtensionInstallPrompt(
  renderer: Electron.WebContents,
  prompt: Omit<BrowserExtensionInstallPromptRequest, 'requestId'>,
  guest?: Electron.WebContents,
  signal?: AbortSignal
): Promise<boolean> {
  if (renderer.isDestroyed() || guest?.isDestroyed() || signal?.aborted) {
    return Promise.resolve(false)
  }
  const requestId = randomUUID()
  return new Promise((resolve) => {
    let settled = false
    const decline = (): void => settle(false)
    const timer = setTimeout(decline, BROWSER_EXTENSION_INSTALL_PROMPT_TIMEOUT_MS)
    const watched: Electron.WebContents[] = guest ? [renderer, guest] : [renderer]
    function settle(accepted: boolean): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      pendingPrompts.delete(requestId)
      signal?.removeEventListener('abort', decline)
      for (const contents of watched) {
        contents.removeListener('destroyed', decline)
        contents.removeListener('render-process-gone', decline)
      }
      guest?.removeListener('did-navigate', decline)
      try {
        if (!renderer.isDestroyed()) {
          renderer.send(BROWSER_EXTENSION_INSTALL_PROMPT_CLOSED_CHANNEL, { requestId })
        }
      } catch {
        // Renderer went away between the check and the send.
      }
      resolve(accepted)
    }
    pendingPrompts.set(requestId, { renderer, settle })
    signal?.addEventListener('abort', decline, { once: true })
    for (const contents of watched) {
      contents.once('destroyed', decline)
      contents.once('render-process-gone', decline)
    }
    // Why did-navigate: it fires only for committed cross-document top-frame loads, not store SPA routes.
    guest?.once('did-navigate', decline)
    try {
      renderer.send(BROWSER_EXTENSION_INSTALL_PROMPT_REQUESTED_CHANNEL, { ...prompt, requestId })
    } catch {
      decline()
    }
  })
}

export function respondToBrowserExtensionInstallPrompt(
  sender: Electron.WebContents,
  response: BrowserExtensionInstallPromptResponse
): boolean {
  const pending = pendingPrompts.get(response.requestId)
  if (!pending || pending.renderer.id !== sender.id) {
    return false
  }
  pending.settle(response.accepted)
  return true
}
