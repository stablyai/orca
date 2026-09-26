import { net, type WebContents } from 'electron'
import { accessSync, constants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalize } from 'node:path'

// Why: Chromium only returns a hung frame's JS stack (collectJavaScriptCallStack)
// when the document opted in with this header; without it the result is a refusal string.
export const JS_CALL_STACK_DOCUMENT_POLICY = 'include-js-call-stacks-in-crash-reports'

function comparablePath(filePath: string): string {
  const normalized = normalize(filePath)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isDocumentUrl(url: string, documentPath: string): boolean {
  try {
    return comparablePath(fileURLToPath(url)) === comparablePath(documentPath)
  } catch {
    return false
  }
}

function isReadable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Serves every main-frame load of `documentPath` (loadFile, recovery, menu/IPC and
 * location reloads) with the JS-call-stack Document-Policy. file:// responses carry no
 * headers and webRequest never sees them, so each navigation arms a one-shot `file`
 * handler that adds it, then unhandles so subresources keep Chromium's native file path.
 */
export function installMainDocumentCallStackPolicy(
  webContents: WebContents,
  documentPath: string
): { dispose: () => void } {
  const { protocol } = webContents.session
  let armed = false

  const disarm = (): void => {
    if (armed) {
      armed = false
      protocol.unhandle('file')
    }
  }

  const arm = (): void => {
    // Owned by someone else, or a missing/unreadable document: Chromium's native
    // handler must report ERR_FILE_NOT_FOUND/ERR_ACCESS_DENIED, not a handler ERR_UNEXPECTED.
    if (armed || protocol.isProtocolHandled('file') || !isReadable(documentPath)) {
      return
    }
    armed = true
    protocol.handle('file', async (request) => {
      let response: Response
      try {
        response = await net.fetch(request, { bypassCustomProtocolHandlers: true })
      } catch (error) {
        disarm()
        throw error
      }
      if (!isDocumentUrl(request.url, documentPath)) {
        return response
      }
      disarm()
      const headers = new Headers(response.headers)
      headers.set('Document-Policy', JS_CALL_STACK_DOCUMENT_POLICY)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      })
    })
  }

  // Verified on Electron 43: arming here still intercepts this navigation's document request.
  const onStartNavigation = (details: {
    url: string
    isMainFrame: boolean
    isSameDocument: boolean
  }): void => {
    if (
      details.isMainFrame &&
      !details.isSameDocument &&
      isDocumentUrl(details.url, documentPath)
    ) {
      try {
        arm()
      } catch (error) {
        // Diagnostic-only: a missing opt-in must never block the window load.
        console.warn('[window] Could not arm the JS call-stack document policy', error)
      }
    }
  }
  // A navigation cancelled before fetching its document must not leave file:// on the JS path.
  const onStopLoading = (): void => disarm()

  webContents.on('did-start-navigation', onStartNavigation)
  webContents.on('did-stop-loading', onStopLoading)
  return {
    dispose: () => {
      if (!webContents.isDestroyed()) {
        webContents.removeListener('did-start-navigation', onStartNavigation)
        webContents.removeListener('did-stop-loading', onStopLoading)
      }
      disarm()
    }
  }
}
