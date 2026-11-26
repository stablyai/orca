// Security invariant: a close keeps whom its closing turn acted for, so a teammate's request taken
// in the owner's own chat is never journaled as the owner's work, and never the owner when Orca
// can't tell.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { OWNER_ACTS_FOR, type BotRequestAsker } from '../../../../shared/bots/bot-acts-for'
import type { BotConversationActsFor } from '../../orchestration/db/bot-requests/bot-conversation-acts-for-store'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { closingChatActsFor, closingTurnActsFor } from './bots-items-close-acts-for'

const CHAT = '11111111-1111-4111-8111-111111111111'
const host = {
  deps: {},
  journals: new Map<string, AgentJournalRenderItem[]>(),
  /** Chats a read opened from rest. */
  opened: new Array<string>(),
  hasSession: (id: string) => host.journals.has(id),
  journalReads: async (id: string) => {
    if (!host.journals.has(id)) {
      host.opened.push(id)
    }
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these of the runtime's methods.
  const runtime = {
    ensureStructuredAgentSessionHost: async () => undefined,
    getExternalConversationSeam: () => null,
    getOrchestrationDb: () => db
  } as unknown as OrcaRuntimeService
  return {
    close: () => closingTurnActsFor(runtime, { sessionId: CHAT, actor: { chatId: CHAT } }),
    closeWithoutTurn: () => closingChatActsFor(runtime, { actor: { chatId: CHAT } })
  }
}

describe('whom a close keeps its closing turn acting for', () => {
  beforeEach(() => {
    host.journals.clear()
    host.opened.length = 0
  })

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
    const { close, closeWithoutTurn } = closing({
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
    // A set to the status the item already has reads no turn, but still its chat's first message.
    expect(await closeWithoutTurn()).toEqual([KEPT])
    expect(await close()).toEqual([KEPT])
    // With no record and the chat at rest, unknown, and nothing opened.
    const atRest = closing({})
    host.journals.clear()
    expect([await atRest.closeWithoutTurn(), host.opened]).toEqual([[{ kind: 'unknown' }], []])
  })

  it("keeps the chat's record when only the whole chat could place the turn", async () => {
    const { close } = closing({ record: { actsFor: [DANA] }, journal: [message('typed')] })
    const reads = host.journalReads
    host.journalReads = async (id: string) => ({
      ...(await reads(id)),
      operationWindow: async () => {
        throw Object.assign(new Error('not indexed'), { name: 'JournalWindowNotIndexed' })
      }
    })
    expect(await close().finally(() => (host.journalReads = reads))).toEqual([KEPT])
  })

  it("keeps the chat's record, opening nothing, when the chat is at rest", async () => {
    const { close } = closing({ record: { actsFor: [DANA] }, journal: [requestMail('req-1')] })
    host.journals.clear()
    expect(await close()).toEqual([KEPT])
    expect(host.opened).toEqual([])
  })

  it("keeps the chat's record when the read fails, and unknown when there is none", async () => {
    const reads = host.journalReads
    host.journalReads = async () => {
      throw new Error('unreadable')
    }
    const results = await Promise.all([
      closing({ record: { actsFor: [DANA] } }).close(),
      closing({}).close()
    ]).finally(() => (host.journalReads = reads))
    expect(results).toEqual([[KEPT], [{ kind: 'unknown' }]])
  })
})
