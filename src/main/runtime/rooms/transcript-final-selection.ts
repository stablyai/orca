import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { findNativeChatFinalMessageIndex } from '../../../shared/native-chat-final-message'

export type PendingProviderMessage = { message: NativeChatMessage; publishable: boolean }

export function selectRoomTranscriptFinal(
  pending: PendingProviderMessage[],
  explicitBody: string | null
): { candidate: PendingProviderMessage | null; body: string | null } {
  const finalIndex = findNativeChatFinalMessageIndex(
    pending.map(({ message }) => message),
    explicitBody === null
  )
  if (finalIndex !== -1) {
    const final = pending[finalIndex]!
    return { candidate: final, body: assistantBody(final.message) }
  }
  const boundary = pending.findLastIndex(({ message }) => message.role === 'user')
  const hasClassifiedAssistant = pending.some(
    ({ message }, index) =>
      index > boundary && message.role === 'assistant' && message.assistantPhase !== undefined
  )
  if (explicitBody) {
    const candidate =
      pending.findLast(
        ({ message }, index) =>
          index > boundary &&
          message.assistantPhase === undefined &&
          finalBodyMatches(assistantBody(message), explicitBody)
      ) ?? null
    return {
      candidate,
      body: candidate
        ? assistantBody(candidate.message)
        : hasClassifiedAssistant
          ? null
          : explicitBody
    }
  }
  return { candidate: null, body: null }
}

export function isRoomActivityMessage(message: NativeChatMessage): boolean {
  return (
    (message.role === 'assistant' && message.assistantPhase !== 'final') ||
    message.role === 'reasoning' ||
    message.role === 'tool'
  )
}

function assistantBody(message: NativeChatMessage): string | null {
  if (message.role !== 'assistant') {
    return null
  }
  const body = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
  return body || null
}

function finalBodyMatches(candidate: string | null, explicit: string): boolean {
  return candidate === explicit || candidate?.startsWith(explicit) === true
}
