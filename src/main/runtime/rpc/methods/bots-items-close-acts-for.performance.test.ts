// Perf contract: whom a close acted for is read without walking the chats' conversation links, so
// its cost doesn't grow with how many conversations are linked.
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { OWNER_ACTS_FOR } from '../../../../shared/bots/bot-acts-for'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { closingTurnActsFor } from './bots-items-close-acts-for'

const CHAT = '11111111-1111-4111-8111-111111111111'
const typed: AgentJournalRenderItem = {
  itemId: 'typed',
  revision: 0,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'typed' }] }
}
const host = {
  deps: {},
  hasSession: (id: string) => id === CHAT,
  journalReads: async () => ({
    operationWindow: async () => ({
      complete: true,
      snapshot: { items: [typed], submissions: [] }
    }),
    promptItem: async () => typed
  })
}
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => host
}))

async function linkVisits(links: number): Promise<number> {
  let visits = 0
  const paneKeys = Array.from({ length: links }, (_, index) => `pane-${index}`)
  // A reply target found by walking every linked conversation, as an unindexed lookup does.
  const seam = {
    replyTarget: (paneKey: string) => {
      for (const key of paneKeys) {
        visits += 1
        if (key === paneKey) {
          return null
        }
      }
      return null
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these of the DB's methods.
  const db = {
    getBotConversationActsFor: () => ({ actsFor: [...OWNER_ACTS_FOR] }),
    getBotRequest: () => undefined
  } as unknown as OrchestrationDb
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these of the runtime's methods.
  const runtime = {
    ensureStructuredAgentSessionHost: async () => undefined,
    getExternalConversationSeam: () => seam,
    getOrchestrationDb: () => db
  } as unknown as OrcaRuntimeService
  expect(await closingTurnActsFor(runtime, { sessionId: CHAT, actor: { chatId: CHAT } })).toEqual(
    OWNER_ACTS_FOR
  )
  return visits
}

describe('a close reads whom it acted for', () => {
  it('visits no conversation link, at 750 links or 7,500', async () => {
    expect([await linkVisits(750), await linkVisits(7500)]).toEqual([0, 0])
  })
})
