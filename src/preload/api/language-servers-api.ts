import type {
  LanguageServerDefinitionLocation,
  LanguageServerDefinitionResult,
  LanguageServerDocumentChange,
  LanguageServerDocumentResult,
  LanguageServerHoverResult,
  LanguageServerPosition,
  LanguageServerStatusEvent
} from '../../shared/language-server-navigation-types'

export type LanguageServersApi = {
  openDocument: (args: {
    worktreeRoot: string
    filePath: string
    text: string
  }) => Promise<LanguageServerDocumentResult>
  changeDocument: (args: {
    filePath: string
    version: number
    changes: readonly LanguageServerDocumentChange[]
  }) => Promise<LanguageServerDocumentResult>
  closeDocument: (args: { filePath: string }) => Promise<LanguageServerDocumentResult>
  definition: (args: {
    filePath: string
    position: LanguageServerPosition
  }) => Promise<LanguageServerDefinitionResult>
  hover: (args: {
    filePath: string
    position: LanguageServerPosition
  }) => Promise<LanguageServerHoverResult>
  /** `$/progress` projection; null clears. Returns an unsubscribe function. */
  onStatus: (callback: (event: LanguageServerStatusEvent) => void) => () => void
}

export type {
  LanguageServerDefinitionLocation,
  LanguageServerDefinitionResult,
  LanguageServerDocumentChange,
  LanguageServerDocumentResult,
  LanguageServerHoverResult,
  LanguageServerPosition,
  LanguageServerStatusEvent
}
