import type {
  LanguageServerDeclarationResult,
  LanguageServerDefinitionLocation,
  LanguageServerDefinitionResult,
  LanguageServerDocumentChange,
  LanguageServerDocumentResult,
  LanguageServerHoverResult,
  LanguageServerPosition,
  LanguageServerReferencesResult,
  LanguageServerSemanticTokensResult,
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
  references: (args: {
    filePath: string
    position: LanguageServerPosition
  }) => Promise<LanguageServerReferencesResult>
  declaration: (args: {
    filePath: string
    position: LanguageServerPosition
  }) => Promise<LanguageServerDeclarationResult>
  hover: (args: {
    filePath: string
    position: LanguageServerPosition
  }) => Promise<LanguageServerHoverResult>
  semanticTokens: (args: { filePath: string }) => Promise<LanguageServerSemanticTokensResult>
  /** `$/progress` projection; null clears. Returns an unsubscribe function. */
  onStatus: (callback: (event: LanguageServerStatusEvent) => void) => () => void
}

export type {
  LanguageServerDeclarationResult,
  LanguageServerDefinitionLocation,
  LanguageServerDefinitionResult,
  LanguageServerDocumentChange,
  LanguageServerDocumentResult,
  LanguageServerHoverResult,
  LanguageServerPosition,
  LanguageServerReferencesResult,
  LanguageServerSemanticTokensResult,
  LanguageServerStatusEvent
}
