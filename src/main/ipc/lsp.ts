import { ipcMain } from 'electron'
import type {
  LspCompletionResult,
  LspDocumentChange,
  LspDocumentContext,
  LspDocumentIdentity,
  LspHover,
  LspLocation,
  LspRequestContext,
  LspServerStatus
} from '../../shared/lsp-types'
import { lspService, type LspServiceStats } from '../lsp/lsp-service'

export function registerLspHandlers(): void {
  ipcMain.handle('lsp:getStatus', (_event, args: LspDocumentIdentity): Promise<LspServerStatus> => {
    return lspService.getStatus(args)
  })

  ipcMain.handle(
    'lsp:openDocument',
    (_event, args: LspDocumentContext): Promise<LspServerStatus> => {
      return lspService.openDocument(args)
    }
  )

  ipcMain.handle('lsp:changeDocument', (_event, args: LspDocumentChange): Promise<void> => {
    return lspService.changeDocument(args)
  })

  ipcMain.handle(
    'lsp:closeDocument',
    (_event, args: Omit<LspDocumentChange, 'content'>): Promise<void> => {
      return lspService.closeDocument(args)
    }
  )

  ipcMain.handle(
    'lsp:completion',
    (_event, args: LspRequestContext): Promise<LspCompletionResult | null> => {
      return lspService.completion(args)
    }
  )

  ipcMain.handle('lsp:hover', (_event, args: LspRequestContext): Promise<LspHover | null> => {
    return lspService.hover(args)
  })

  ipcMain.handle('lsp:definition', (_event, args: LspRequestContext): Promise<LspLocation[]> => {
    return lspService.definition(args)
  })

  ipcMain.handle('lsp:getStats', (): LspServiceStats => {
    return lspService.getStats()
  })
}
