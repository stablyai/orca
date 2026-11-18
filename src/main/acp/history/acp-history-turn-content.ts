import { createHash } from 'node:crypto'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../../../shared/native-chat/native-chat-types'

/** A chat-sent turn as coverage matching compares it; `text` digests a text-only prompt. */
export type AcpNativeTurn = {
  itemId: string
  sequence: number
  text: string | null
  output: boolean
}

export function acpHistoryHasOutput(body: AgentJournalItemBody): boolean {
  return (
    body.kind !== 'turn' &&
    !(body.kind === 'message' && body.role === 'user') &&
    (body.kind !== 'message' ||
      body.blocks.some((block) => block.type !== 'text' || block.text.length > 0))
  )
}

/** Prompts compare by digest so a long saved prompt never crosses the reader reply. */
export function acpPromptDigest(blocks: readonly NativeChatBlock[]): string | null {
  return blocks.every((block) => block.type === 'text')
    ? createHash('sha256')
        .update(blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'))
        .digest('hex')
    : null
}
