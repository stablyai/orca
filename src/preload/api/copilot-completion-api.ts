import type {
  CopilotChangeDocumentArgs,
  CopilotCloseDocumentArgs,
  CopilotInlineCompletionArgs,
  CopilotInlineCompletionResult,
  CopilotOpenDocumentArgs,
  CopilotOpenDocumentResult,
  CopilotSignInResult,
  CopilotStatus
} from '../../shared/copilot-inline-completion-types'

export type CopilotCompletionApi = {
  openDocument: (args: CopilotOpenDocumentArgs) => Promise<CopilotOpenDocumentResult>
  changeDocument: (args: CopilotChangeDocumentArgs) => Promise<void>
  closeDocument: (args: CopilotCloseDocumentArgs) => Promise<void>
  inlineCompletion: (args: CopilotInlineCompletionArgs) => Promise<CopilotInlineCompletionResult>
  status: () => Promise<CopilotStatus>
  signIn: () => Promise<CopilotSignInResult>
  onStatus: (callback: (status: CopilotStatus) => void) => () => void
}
