// Security invariant: a close keeps whom its closing turn acted for, so a teammate's request taken
// in the owner's own chat is never journaled as the owner's work, and never the owner when Orca
// can't tell.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { OWNER_ACTS_FOR, type BotRequestAsker } from '../../../../shared/bots/bot-acts-for'
import type { BotConversationActsFor } from '../../orchestration/db/bot-requests/bot-conversation-acts-for-store'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { closingTurnActsFor } from './bots-items-close-acts-for'

const CHAT = '11111111-1111-4111-8111-111111111111'
const host = {
  deps: {},
  journals: new Map<string, AgentJournalRenderItem[]>(),
  journalReads: async (id: string) => {
    const items = host.journals.get(id) ?? []
    return {
      operationWindow: async () => ({ complete: true, snapshot: { items, submissions: [] } }),
      promptItem: async () => items[0] ?? null
    }
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

let sequence = 0
function message(itemId: string, body: Record<string, unknown> = {}): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }], ...body }
  }
}

/** Mail delivering the bot request `messageId` into the chat. */
const requestMail = (messageId: string) =>
  message(`mail-${messageId}`, {
    from: {
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'asker',
        dispatchId: null,
        messages: [{ messageId, runId: 'run-1', from: 'asker' }]
      }
    }
  })

function closing(input: {
  record?: BotConversationActsFor
  journal?: AgentJournalRenderItem[]
  requests?: Record<string, BotRequestAsker[]>
  runs?: { chatSessionId: string; automationId: string }[]
  automations?: string[]
}) {
  host.journals.set(CHAT, input.journal ?? [])
  const records = new Map<string, BotConversationActsFor>(
    input.record ? [[CHAT, input.record]] : []
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these of the DB's methods.
  const db = {
    getBotConversationActsFor: (id: string) => records.get(id),
    recordBotConversationActsFor: (id: string, record: BotConversationActsFor) =>
      records.has(id) || records.set(id, record),
    getBotRequest: (id: string) => {
      const askers = input.requests?.[id]
      return askers ? { record: JSON.stringify({ askers }) } : undefined
    }
  } as unknown as OrchestrationDb
  const listed = { runs: 0 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these of the runtime's methods.
  const runtime = {
    ensureStructuredAgentSessionHost: async () => undefined,
    getExternalConversationSeam: () => null,
    getOrchestrationDb: () => db,
    listAutomationRuns: () => (listed.runs++, input.runs ?? []),
    showAutomation: (id: string) => {
      if (!input.automations?.includes(id)) {
        throw new Error('gone')
      }
      return { id }
    }
  } as unknown as OrcaRuntimeService
  return {
    listed,
    close: () => closingTurnActsFor(runtime, { sessionId: CHAT })
  }
}

describe('whom a close keeps its closing turn acting for', () => {
  beforeEach(() => host.journals.clear())

  it("keeps a teammate's request taken in the owner's own chat as theirs, naming who but not where", async () => {
    const { close } = closing({
      record: { actsFor: [...OWNER_ACTS_FOR] },
      journal: [requestMail('req-1')],
      requests: { 'req-1': [DANA] }
    })
    expect(await close()).toEqual([{ kind: 'owner' }, KEPT])
  })

  it("keeps the owner's own turn in the owner's chat as the owner's", async () => {
    const { close } = closing({
      record: { actsFor: [...OWNER_ACTS_FOR] },
      journal: [message('typed')]
    })
    expect(await close()).toEqual([{ kind: 'owner' }])
  })

  it("never keeps a turn a device Orca can't place typed in as the owner's", async () => {
    const { close } = closing({
      record: { actsFor: [...OWNER_ACTS_FOR] },
      journal: [message('typed', { typedBy: { by: 'device', deviceId: 'phone' } })]
    })
    expect(await close()).toEqual([{ kind: 'owner' }, { kind: 'unknown' }])
  })

  it("keeps a teammate chat's turn as the teammate's, by its first message when there is no record", async () => {
    const { close } = closing({
      journal: [
        message('asked', {
          origin: 'connector',
          asker: {
            source: 'slack',
            userId: 'U_DANA',
            name: 'Dana',
            role: 'member',
            place: { kind: 'public_channel', id: 'C1' }
          }
        })
      ]
    })
    expect(await close()).toEqual([KEPT])
  })

  it("keeps an old automation chat whose automation still exists as the owner's, searching its runs once", async () => {
    const legacy = {
      record: {
        actsFor: [...OWNER_ACTS_FOR, { kind: 'unknown' as const }],
        triggeredBy: { source: 'slack' }
      },
      runs: [{ chatSessionId: CHAT, automationId: 'auto-1' }]
    }
    const kept = closing({ ...legacy, automations: ['auto-1'] })
    expect([await kept.close(), await kept.close()]).toEqual([
      [{ kind: 'owner' }],
      [{ kind: 'owner' }]
    ])
    expect(kept.listed.runs).toBe(1)
    const gone = closing({ ...legacy, record: { ...legacy.record } })
    expect(await gone.close()).toEqual([{ kind: 'owner' }, { kind: 'unknown' }])
  })

  it('is unknown, never the owner, when the read fails', async () => {
    const { close } = closing({})
    const reads = host.journalReads
    host.journalReads = async () => {
      throw new Error('unreadable')
    }
    expect(await close().finally(() => (host.journalReads = reads))).toEqual([{ kind: 'unknown' }])
  })
})
