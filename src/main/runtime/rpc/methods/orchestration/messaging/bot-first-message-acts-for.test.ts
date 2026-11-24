import { expect, it } from 'vitest'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { JournalSqlReads } from '../../../../../native-chat/agent-session-journal/journal-sql-reads'
import {
  createOrcaSessionId,
  formatOrcaSessionAddress
} from '../../../../../../shared/agent-session/identity/orca-session-address'
import { isPulledRequestChat } from './bot-first-message-acts-for'

const OWNER = [{ kind: 'owner' }]
const ROOT = createOrcaSessionId(() => '22222222-2222-4222-8222-222222222222')
const OTHER = createOrcaSessionId(() => '33333333-3333-4333-8333-333333333333')

// An earlier version recorded a request pulled from a paired server as the owner's; it is filed
// under the server's reverse conversation. A direct one is filed under a conversation with none.
const requests: Record<string, { to: string; environmentId: string | null }> = {
  msg_pulled_here: { to: formatOrcaSessionAddress(ROOT), environmentId: 'env_s' },
  msg_pulled_elsewhere: { to: formatOrcaSessionAddress(OTHER), environmentId: 'env_s' },
  msg_direct_here: { to: formatOrcaSessionAddress(ROOT), environmentId: null }
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these four lookups.
const db = {
  getBotRequest: (id: string) =>
    requests[id]
      ? {
          record: JSON.stringify({
            purpose: 'question',
            fromPairedComputer: 'Build Box',
            askers: OWNER,
            askedBy: OWNER
          })
        }
      : undefined,
  getPeerMailMessage: (id: string) => (requests[id] ? { conversation_id: id } : undefined),
  getPeerMailConversation: (id: string) =>
    requests[id] ? { role: 'peer', environment_id: requests[id].environmentId } : undefined,
  getMessageById: (id: string) => (requests[id] ? { to_handle: requests[id].to } : undefined)
} as unknown as OrchestrationDb

/** A chat whose first message is mail naming `messageIds`, or one a person typed. */
function firstPrompt(messageIds: string[] | null): Promise<Pick<JournalSqlReads, 'promptItem'>> {
  const body = messageIds
    ? {
        kind: 'message',
        text: 'mail',
        from: {
          orchestration: {
            message: 'mail-notice',
            messages: messageIds.map((messageId) => ({ messageId }))
          }
        }
      }
    : { kind: 'message', text: 'hello' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only the first prompt's body.
  return Promise.resolve({
    promptItem: async () => ({ itemId: 'i', revision: 1, sequence: 0, observedAt: 0, body })
  } as unknown as Pick<JournalSqlReads, 'promptItem'>)
}

it('knows a chat started for a pulled request, addressed to that chat, as acting for no one', async () => {
  expect(await isPulledRequestChat(db, firstPrompt(['msg_pulled_here']), ROOT)).toBe(true)
})

it('keeps a chat a person opened, a direct request, and a chat that only received pulled mail later', async () => {
  expect(await isPulledRequestChat(db, firstPrompt(null), ROOT)).toBe(false)
  expect(await isPulledRequestChat(db, firstPrompt(['msg_direct_here']), ROOT)).toBe(false)
  // Its first message is a pulled request, but one another chat was started for.
  expect(await isPulledRequestChat(db, firstPrompt(['msg_pulled_elsewhere']), ROOT)).toBe(false)
})
