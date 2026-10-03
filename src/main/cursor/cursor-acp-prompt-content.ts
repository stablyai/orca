import { z } from 'zod'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import {
  claudeDispatchMessageContent,
  ClaudeDispatchContentError
} from '../claude/claude-structured-dispatch-content'
import type { CursorAcpCapabilities } from './cursor-acp-connection'

const contentSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    source: z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() })
  })
])

export function cursorDispatchRejection(failure: SubmissionRejectionFact) {
  return agentSessionFailureWords(failure, {
    surface: 'rejection',
    agentName: 'Cursor'
  })
}

/** Reuse the existing bounded attachment reader and budget before adapting its content envelope. */
export async function cursorAcpPromptContent(
  body: AgentJournalMessageItem,
  capabilities: CursorAcpCapabilities
): Promise<Record<string, unknown>[]> {
  if (
    body.blocks.some(
      (block) =>
        block.type === 'image-ref' && (capabilities.promptCapabilities?.image !== true || block.url)
    )
  ) {
    throw new ClaudeDispatchContentError(
      'Cursor ACP cannot take this image source',
      agentSessionFailureFact('attachmentInvalid', { attachment: { reason: 'unsupportedType' } })
    )
  }
  return (await claudeDispatchMessageContent(body)).map((value) => {
    const content = contentSchema.parse(value)
    return content.type === 'text'
      ? content
      : { type: 'image', data: content.source.data, mimeType: content.source.media_type }
  })
}

export function cursorPromptContentRejection(error: unknown) {
  return cursorDispatchRejection(
    error instanceof ClaudeDispatchContentError
      ? error.failure
      : agentSessionFailureFact('attachmentUnreadable')
  )
}
