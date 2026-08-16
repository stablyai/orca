import { app, ipcMain, webContents } from 'electron'
import type { Store } from '../persistence'
import {
  LSP_REQUEST_METHODS,
  type LspChangeDocumentArgs,
  type LspCloseDocumentArgs,
  type LspOpenDocumentArgs,
  type LspOpenDocumentResult,
  type LspRequestArgs
} from '../../shared/lsp-types'
import { createLspSessionManager } from '../lsp/lsp-session-manager'
import { resolveAuthorizedPath } from './filesystem-auth'
import { isDescendantOrEqual } from './filesystem-path-containment'

export function registerLspHandlers(store: Store): void {
  const manager = createLspSessionManager()
  // Why: diagnostics go to every window; sessions are keyed by workspace, and
  // stale-model payloads are dropped renderer-side by uri lookup.
  manager.onDiagnostics((payload) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) {
        contents.send('lsp:diagnostics', payload)
      }
    }
  })
  app.on('will-quit', () => manager.disposeAll())

  ipcMain.handle(
    'lsp:openDocument',
    async (_event, args: LspOpenDocumentArgs): Promise<LspOpenDocumentResult> => {
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      const rootPath = await resolveAuthorizedPath(args.rootPath, store)
      // Why: both paths are individually authorized, but rootPath becomes the
      // server's cwd/workspace — it must actually contain the opened file, or a
      // renderer could scope a code-executing server (gopls, rust-analyzer) to
      // an unrelated allowed root.
      if (!isDescendantOrEqual(filePath, rootPath)) {
        throw new Error('LSP document must be inside its workspace root')
      }
      return manager.openDocument({
        filePath,
        rootPath,
        languageId: args.languageId,
        text: args.text
      })
    }
  )

  ipcMain.handle('lsp:changeDocument', (_event, args: LspChangeDocumentArgs): void => {
    manager.changeDocument(args.sessionId, args.fileUri, args.text)
  })

  ipcMain.handle('lsp:closeDocument', (_event, args: LspCloseDocumentArgs): void => {
    manager.closeDocument(args.sessionId, args.fileUri)
  })

  ipcMain.handle('lsp:request', (_event, args: LspRequestArgs): Promise<unknown> => {
    if (!LSP_REQUEST_METHODS.includes(args.method)) {
      return Promise.reject(new Error(`Unsupported LSP method: ${String(args.method)}`))
    }
    return manager.request(args.sessionId, args.method, args.params)
  })
}
