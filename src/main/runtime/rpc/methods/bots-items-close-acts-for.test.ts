// Security invariant: a close keeps whom its chat acts for, read without opening a conversation,
// and never the owner when Orca can't tell.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { BotRequestAsker } from '../../../../shared/bots/bot-acts-for'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { closingChatActsFor } from './bots-items-close-acts-for'

const host = {
  open: new Set<string>(),
  firsts: new Map<string, AgentJournalRenderItem>(),
  reads: new Array<string>(),
  hasSession: (id: string) => host.open.has(id),
  journalReads: async (id: string) => {
    host.reads.push(id)
    if (!host.open.has(id)) {
      throw new Error('opened a conversation')
    }
    return { promptItem: async () => host.firsts.get(id) ?? null }
  }
}
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => host
}))

const DANA: BotRequestAsker = {
  kind: 'person',
  source: 'slack',
  userId: 'U_DANA',
  name: 'Dana',
  workspaceId: 'T1',
  role: 'member',
  placeKind: 'public_channel'
}
const KEPT = {
  kind: 'person',
  source: 'slack',
  userId: 'U_DANA',
  name: 'Dana',
  workspaceId: null,
  role: 'member'
}

function closing(root: string, records: Record<string, BotRequestAsker[]> = {}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close reads only these two of the DB's methods.
  const db = {
    getBotConversationActsFor: (id: string) => (records[id] ? { actsFor: records[id] } : undefined),
    getBotRequest: () => undefined
  } as unknown as OrchestrationDb
  return closingChatActsFor(
    { runtime: { getOrchestrationDb: () => db } },
    { actor: { chatId: root } }
  )
}

describe('whom a close keeps its chat acting for', () => {
  beforeEach(() => {
    host.open.clear()
    host.firsts.clear()
    host.reads.length = 0
  })

  it('keeps the record, naming who but not where', async () => {
    expect(await closing('root', { root: [DANA] })).toEqual([KEPT])
    expect(host.reads).toEqual([])
  })

  it("reads an open root's first message when there is no record", async () => {
    host.open.add('root')
    host.firsts.set('root', {
      itemId: 'm1',
      revision: 0,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'hi' }],
        origin: 'connector',
        asker: {
          source: 'slack',
          userId: 'U_DANA',
          name: 'Dana',
          role: 'member',
          place: { kind: 'public_channel', id: 'C1' }
        }
      }
    })
    expect(await closing('root')).toEqual([KEPT])
  })

  it('is unknown, opening nothing, when the root has no record and is not open', async () => {
    host.open.add('continuation')
    expect(await closing('root')).toEqual([{ kind: 'unknown' }])
    expect(host.reads).toEqual([])
  })
})
