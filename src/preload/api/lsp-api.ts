import type {
  LspChangeDocumentArgs,
  LspCloseDocumentArgs,
  LspDiagnosticsPayload,
  LspOpenDocumentArgs,
  LspOpenDocumentResult,
  LspRequestArgs
} from '../../shared/lsp-types'

export type LspApi = {
  openDocument: (args: LspOpenDocumentArgs) => Promise<LspOpenDocumentResult>
  changeDocument: (args: LspChangeDocumentArgs) => Promise<void>
  closeDocument: (args: LspCloseDocumentArgs) => Promise<void>
  request: (args: LspRequestArgs) => Promise<unknown>
  onDiagnostics: (callback: (payload: LspDiagnosticsPayload) => void) => () => void
}
