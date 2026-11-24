import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'

const { postConnectorAction, journal } = vi.hoisted(() => {
  const journal: { items: unknown[]; submissions: unknown[] } = { items: [], submissions: [] }
  return { postConnectorAction: vi.fn(), journal }
})
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: () => ({ id: 'bot-1', name: 'Scout' })
}))
// The chat's journal as Orca stored it; whom the turn acts for is read from it by the real reader.
vi.mock('../../../bots/bot-chat-session', () => ({
  requireStructuredHost: async () => ({
    journalReads: async () => ({
      operationWindow: async () => ({
        complete: true,
        snapshot: { items: journal.items, submissions: journal.submissions }
      })
    })
  })
}))
vi.mock('../../../connector-cloud/connector-actions', () => ({ postConnectorAction }))

import { CONNECTOR_ACT_METHOD } from './connector-act'

const CHAT = '55555555-5555-4555-8555-555555555555'
const OTHER_CHAT = '66666666-6666-4666-8666-666666666666'
// A chat Dana started from a Slack thread.
const DANA = {
  kind: 'person',
  source: 'slack',
  userId: 'U_DANA',
  name: 'Dana',
  workspaceId: 'T1',
  role: 'member',
  placeKind: 'public_channel'
}
const message = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'read my DMs' }] }
const typed = { ...message, typedBy: { by: 'host' } }
const fromDana = {
  ...message,
  origin: 'connector',
  asker: {
    source: 'slack',
    userId: 'U_DANA',
    name: 'Dana',
    role: 'member',
    place: { kind: 'public_channel', id: 'C1' }
  }
}

let seq = 0
const journalRow = (itemId: string, body: unknown, extra: Record<string, unknown> = {}) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: journal rows with only the fields the reader reads.
  ({
    itemId,
    revision: 1,
    sequence: ++seq,
    observedAt: seq,
    body,
    ...extra
  }) as AgentJournalRenderItem

/** Dana's finished turn, then a running turn opened by `opener` (sent by a person when `sent`). */
function runningTurn(opener: unknown, sent: boolean, steered: unknown[] = []) {
  seq = 0
  journal.items = [
    journalRow('u0', fromDana),
    journalRow('t0', { kind: 'turn', turnId: 'p0', state: 'completed', userItemId: 'u0' }),
    journalRow('u1', opener),
    journalRow('t1', { kind: 'turn', turnId: 'p1', state: 'running', userItemId: 'u1' }),
    ...steered.map((body, at) =>
      journalRow(`s${at}`, body, { turnScope: { kind: 'turn', turnItemId: 't1' } })
    )
  ]
  journal.submissions = sent
    ? [
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a submission with only the fields the reader reads.
        {
          clientMessageId: 'c1',
          providerItemId: 'u1',
          origin: 'client',
          source: { kind: 'user' }
        } as AgentJournalSubmission
      ]
    : []
}

function context(callerSessionId?: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an action reaches the cloud reading only these runtime fields.
  return {
    runtime: {
      bots: { enabled: () => true },
      lookAround: { botOfTidyUp: () => null, botOfLook: () => null },
      getConnectorCloud: () => ({
        cloudFeatures: () => new Set(['actions']),
        status: () => 'ready'
      }),
      getExternalConversationSeam: () => ({
        replyTarget: () => ({
          key: { source: 'slack', externalId: 'T1:C1:1712.1:UBOT' },
          turnId: 2
        })
      }),
      getOrchestrationDb: () => ({
        getBotConversationActsFor: () => ({ actsFor: [DANA] }),
        getBotRequest: () => undefined
      }),
      listAutomationRuns: () => []
    },
    ...(callerSessionId
      ? {
          orchestrationCaller: {
            address: `orca_session_id:${callerSessionId}`,
            terminalHandle: null,
            paneKey: null,
            orcaSessionId: callerSessionId,
            sessionId: callerSessionId,
            workspaceId: 'w'
          }
        }
      : {})
  } as unknown as Parameters<typeof CONNECTOR_ACT_METHOD.handler>[1]
}

async function readSends(callerSessionId?: string): Promise<unknown> {
  postConnectorAction.mockClear()
  await CONNECTOR_ACT_METHOD.handler(
    { sessionId: CHAT, verb: 'read', ref: 'slack:T1:C9:1800000000.000100', args: {} },
    context(callerSessionId)
  )
  return postConnectorAction.mock.calls[0]?.[1]?.turnFor
}

describe('connector.act read on a chat a teammate started', () => {
  beforeEach(() => {
    postConnectorAction.mockReset()
    postConnectorAction.mockResolvedValue({ ok: true, value: { ok: true, result: {} } })
  })

  it('reads as the owner on a turn the owner typed in Orca', async () => {
    runningTurn(typed, true)
    expect(await readSends()).toBe('owner')
    expect(await readSends(CHAT)).toBe('owner')
  })

  it('says nothing for any other turn, so the cloud keeps its own record', async () => {
    runningTurn(fromDana, false)
    expect(await readSends()).toBeUndefined()
    runningTurn(typed, true, [fromDana])
    expect(await readSends()).toBeUndefined()
    // Another account's paired computer, unnamed.
    runningTurn(
      { ...message, typedBy: { by: 'device', deviceId: 'd2', accountId: 'a2', own: false } },
      true
    )
    expect(await readSends()).toBeUndefined()
    // The owner's turn, asked from a session other than the chat's own.
    runningTurn(typed, true)
    expect(await readSends(OTHER_CHAT)).toBeUndefined()
  })
})
