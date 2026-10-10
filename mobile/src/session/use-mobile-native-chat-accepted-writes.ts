import type { AskAnswerSelection, AskPrompt } from '../../../src/shared/native-chat-ask'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'

/**
 * The chat writes that retire the route's held failure banner: answering the ask, cancelling it, a
 * permission reply and a structured prompt cancel.
 *
 * The banner outlives the write that raised it, so every accepted action has to retire it — not
 * just the composer send, which was the only one that did. A delivered answer or permission reply
 * otherwise sits under a stale "not sent" until the hold timer happens to expire.
 *
 * Kept out of the controller to hold its length: its hook order is fixed, and these four wrappers
 * run contiguously there.
 */
export function useMobileNativeChatAcceptedWrites(args: {
  structured: boolean
  /** The legacy lane's writes; ignored while `structured`. */
  legacyAnswerAsk: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  legacyCancelAsk: () => Promise<boolean>
  legacyRespondPermission: (text: string) => Promise<boolean>
  /** The structured lane's writes; ignored unless `structured`. */
  structuredRespondPermission: (optionId: string) => Promise<boolean>
  structuredCancelPrompt: (prompt?: {
    itemId: string
    expectedRevision: number
  }) => Promise<boolean>
  /** Retires the held failure banner. */
  onSendResolved: () => void
}): {
  answerAsk: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  cancelAsk: () => Promise<boolean>
  respondPermission: (text: string) => Promise<boolean>
  cancelPrompt: (prompt?: { itemId: string; expectedRevision: number }) => Promise<boolean>
} {
  const { structured } = args
  const answerAsk = useNativeChatAcceptedAction(args.legacyAnswerAsk, args.onSendResolved)
  const cancelAsk = useNativeChatAcceptedAction(args.legacyCancelAsk, args.onSendResolved)
  const respondPermission = useNativeChatAcceptedAction(
    structured ? args.structuredRespondPermission : args.legacyRespondPermission,
    args.onSendResolved
  )
  const cancelPrompt = useNativeChatAcceptedAction(
    structured ? args.structuredCancelPrompt : async () => false,
    args.onSendResolved
  )
  return { answerAsk, cancelAsk, respondPermission, cancelPrompt }
}
