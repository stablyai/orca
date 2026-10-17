import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

/** Hides structured turn details in terminal mode while retaining host input restrictions. */
export function mobileNativeChatStructuredPresentation(
  session: ReturnType<typeof useMobileStructuredAgentSession>,
  structured: boolean
) {
  const active = structured ? session : null
  return {
    nativeChatVisualSource: active?.visualSource ?? null,
    nativeChatTurnIndicator: active?.turnIndicator ?? null,
    nativeChatWorkingStartedAt: active?.workingStartedAt ?? null,
    nativeChatSettledTurns: active?.settledTurns ?? null,
    nativeChatTurnJournal: active?.turnJournal ?? null,
    nativeChatReceipts: active?.receipts ?? null,
    nativeChatBackgroundTasks: active?.backgroundTasks ?? null,
    nativeChatAcceptsImages: active?.acceptsImages ?? true,
    nativeChatActionablePromptIds: session.actionablePromptIds,
    nativeChatCommandRefusalCauses: session.commandRefusalCauses,
    nativeChatQueued: session.queued
  }
}
