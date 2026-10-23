import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { expect } from 'vitest'
import { isStructuredHumanReply } from '../notifications/structured-reply-origin'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

export async function expectCompletedHumanReply(
  provider: { notify: (method: string, params: unknown) => void },
  drain: () => Promise<void>,
  sessionId: string,
  turnId: string
): Promise<void> {
  provider.notify('turn/completed', { turn: { id: turnId } })
  await drain()
  const reply = getStructuredAgentSessionHost()?.replyJournal.snapshot(sessionId)
  if (!reply) {
    throw new Error('live reply journal missing')
  }
  expect(isStructuredHumanReply(reply, turnId)).toBe(true)
}

export function textOf(item: AgentJournalRenderItem): string {
  const body = item.body
  return body?.kind === 'message'
    ? body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    : ''
}
