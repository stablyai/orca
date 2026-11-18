import { COORDINATOR, host } from './structured-chat-coordinator-mail-rig.test-fixture'

export async function queuedCardTexts(sessionId = COORDINATOR): Promise<string[]> {
  const page = await host.history({ sessionId, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return (page.page.queuedMessages ?? []).flatMap((card) =>
    card.body.blocks.map((block) => (block.type === 'text' ? block.text : ''))
  )
}

export function journalOf(sessionId: string) {
  const session = host.collaboratorsForTests().sessions.get(sessionId)
  if (!session) {
    throw new Error('Conversation was not opened')
  }
  return session.journal
}
export const queuedRows = (sessionId: string) => journalOf(sessionId).queuedMessages.list()
