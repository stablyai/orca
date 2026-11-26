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
import { findLiveAutomationOfRunChat } from '../../../persistence/scheduling-automations/automation-run-chat-lookup'

const CHAT = '11111111-1111-4111-8111-111111111111'
const host = {
  deps: {},
  journals: new Map<string, AgentJournalRenderItem[]>(),
  /** The window reads the close asked for. */
  windows: new Array<Record<string, unknown>>(),
  hasSession: (id: string) => host.journals.has(id),
  journalReads: async (id: string) => {
    if (!host.journals.has(id)) {
      throw new Error('opened a conversation')
    }
    const items = host.journals.get(id) ?? []
    return {
      operationWindow: async (anchors: Record<string, unknown>) => {
        host.windows.push(anchors)
        return { complete: true, snapshot: { items, submissions: [] } }
      },
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
  // The run history and automations as persistence keeps them: each change replaces the array.
  const history = {
    automationRuns: input.runs ?? [],
    automations: (input.automations ?? []).map((id) => ({ id }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these of the runtime's methods.
  const runtime = {
    ensureStructuredAgentSessionHost: async () => undefined,
    getExternalConversationSeam: () => null,
    getOrchestrationDb: () => db,
    findLiveAutomationOfRunChat: (chat: string) => findLiveAutomationOfRunChat(history, chat)
  } as unknown as OrcaRuntimeService
  return {
    history,
    close: () => closingTurnActsFor(runtime, { sessionId: CHAT })
  }
}

describe('whom a close keeps its closing turn acting for', () => {
  beforeEach(() => {
    host.journals.clear()
    host.windows.length = 0
  })

  it("keeps a teammate's request taken in the owner's own chat as theirs, naming who but not where", async () => {
    const { close } = closing({
      record: { actsFor: [...OWNER_ACTS_FOR] },
      journal: [requestMail('req-1')],
      requests: { 'req-1': [DANA] }
    })
    expect(await close()).toEqual([{ kind: 'owner' }, KEPT])
    // By index alone: an old unanswered send never pins the read back to the whole chat.
    expect(host.windows).toEqual([
      { latestTurns: 8, turnShape: true, anchorsOnly: true, indexedOnly: true }
    ])
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

  it("keeps an old automation chat as the owner's while its automation exists, and again once a run lands in it", async () => {
    const record = {
      actsFor: [...OWNER_ACTS_FOR, { kind: 'unknown' as const }],
      triggeredBy: { source: 'slack' }
    }
    const run = { chatSessionId: CHAT, automationId: 'auto-1' }
    const kept = closing({ record, runs: [run], automations: ['auto-1'] })
    expect(await kept.close()).toEqual([{ kind: 'owner' }])
    const gone = closing({ record, runs: [run] })
    expect(await gone.close()).toEqual([{ kind: 'owner' }, { kind: 'unknown' }])
    // Its run aged out of the history, then the automation ran in the chat again.
    const pruned = closing({ record, automations: ['auto-1'] })
    expect(await pruned.close()).toEqual([{ kind: 'owner' }, { kind: 'unknown' }])
    pruned.history.automationRuns = [run]
    expect(await pruned.close()).toEqual([{ kind: 'owner' }])
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
