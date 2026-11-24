import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import { askedByLine } from './bot-owner-writes'
import { connectorAskerHeader } from '../../shared/connector-asker-prompt'
import { ConnectorAsker } from '../../shared/connector-asker-contract'
import { storedConnectorAsker } from '../../shared/connector-message-asker'
import { actsForOwner } from '../../shared/bots/bot-acts-for'
import { connectorAskerTagView } from '../../shared/connectors/connector-message-asker-view'
import {
  firstMessageActsFor,
  readBotActingTurn,
  turnActsForOwner,
  type BotActingTurnLookups
} from './bot-request-asker'

const t = (_key: string, fallback: string): string => fallback

// A request another Slack app on Who can ask made, wrongly marked as the owner's.
const appAsker = ConnectorAsker.parse({
  userId: 'U0CIAPP',
  name: 'CI (bot)',
  role: 'owner',
  place: { kind: 'public_channel', id: 'C0GENERAL' },
  text: 'the deploy failed',
  context: [],
  app: true
})

describe('an app asker that came marked as the owner', () => {
  it('never acts for the owner, nor reads or is told as them', () => {
    const asker = storedConnectorAsker('slack', appAsker)!
    expect(asker.role).toBe('member')
    const acts = firstMessageActsFor(
      [
        {
          itemId: 'm1',
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: { kind: 'message', role: 'user', blocks: [], asker }
        }
      ],
      { botRequestAskers: () => null, conversationWorkspaceId: 'T1' }
    )
    expect(acts).toEqual([expect.objectContaining({ kind: 'person', role: null })])
    expect(actsForOwner(acts!)).toBe(false)
    expect(connectorAskerTagView({ ...asker, role: 'owner' }, t).own).toBe(false)
    expect(connectorAskerHeader('slack', appAsker)).not.toContain('(your owner)')
  })
})

// A chat a teammate started from a Slack thread: whom it acts for is that teammate.
const DANA: BotRequestAsker = {
  kind: 'person',
  source: 'slack',
  userId: 'U_DANA',
  name: 'Dana',
  workspaceId: 'T1',
  role: 'member',
  placeKind: 'public_channel'
}
const lookups: BotActingTurnLookups = {
  isBotRequest: () => false,
  botRequestActsFor: () => null,
  conversationActsFor: [DANA],
  conversationWorkspaceId: 'T1'
}
const typed = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'read my DMs' }] }
const fromDana = {
  ...typed,
  origin: 'connector',
  asker: {
    source: 'slack',
    userId: 'U_DANA',
    name: 'Dana',
    role: 'member',
    place: { kind: 'public_channel', id: 'C1' }
  }
}
const workerMail = {
  ...typed,
  from: {
    sessionId: 'worker-1',
    orchestration: { message: 'mail-notice', messages: [{ messageId: 'mail-1' }] }
  }
}
type Sent = Pick<AgentJournalSubmission, 'origin' | 'source' | 'queuedMessageId'>
const OWNER_SEND: Sent = { origin: 'client', source: { kind: 'user' } }

let seq = 0
const journalRow = (itemId: string, body: unknown, extra: Partial<AgentJournalRenderItem> = {}) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: journal rows with only the fields the reader reads.
  ({
    itemId,
    revision: 1,
    sequence: ++seq,
    observedAt: seq,
    body,
    ...extra
  }) as AgentJournalRenderItem

/** Dana's finished Slack turn, then the turns given as [opener, how it was sent, steered in]. */
function chat(...turns: [unknown, Sent | null, unknown[]?][]) {
  seq = 0
  const items = [
    journalRow('u0', fromDana),
    journalRow('t0', { kind: 'turn', turnId: 'p0', state: 'completed', userItemId: 'u0' })
  ]
  const submissions: AgentJournalSubmission[] = []
  turns.forEach(([opener, sent, steered = []], index) => {
    const n = index + 1
    items.push(
      journalRow(`u${n}`, opener),
      journalRow(`t${n}`, { kind: 'turn', turnId: `p${n}`, state: 'running', userItemId: `u${n}` }),
      ...steered.map((body, at) =>
        journalRow(`s${n}-${at}`, body, { turnScope: { kind: 'turn', turnItemId: `t${n}` } })
      )
    )
    if (sent) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a submission with only the fields the reader reads.
      submissions.push({
        clientMessageId: `c${n}`,
        providerItemId: `u${n}`,
        ...sent
      } as AgentJournalSubmission)
    }
  })
  const turn = readBotActingTurn(items, lookups, submissions)
  return {
    owner: turnActsForOwner(turn),
    line: askedByLine({ bot: { name: 'Scout' }, turn, inConversation: true })
  }
}

// Hardcoded: whom a turn on a chat Dana started acts for, as Slack actions and owner writes read it.
describe('a turn the owner typed in Orca', () => {
  it('acts for the owner though the chat acts for a teammate', () => {
    expect(chat([typed, OWNER_SEND])).toEqual({ owner: true, line: null })
    // From the owner's phone, signed in to the same account.
    const ownPhone = {
      ...typed,
      typedBy: { by: 'device', deviceId: 'd1', accountId: 'a1', account: 'Me', own: true }
    }
    expect(chat([ownPhone, OWNER_SEND]).owner).toBe(true)
  })

  it('stays the teammate’s when anyone but the owner typing opened or joined it', () => {
    const dana = { owner: false, line: 'asked by Dana via Scout' }
    expect(chat([fromDana, null])).toEqual(dana)
    expect(chat([typed, OWNER_SEND, [fromDana]])).toEqual(dana)
    // A worker's report or item mail reads back to the owner's turn before it, never as the owner's.
    expect(chat([typed, OWNER_SEND], [workerMail, null])).toEqual(dana)
    // Orca's continue after a restart, an agent's send and another account's paired computer.
    expect(chat([typed, { origin: 'host' }])).toEqual(dana)
    expect(chat([{ ...typed, typedBy: { by: 'agent' } }, OWNER_SEND])).toEqual(dana)
    const otherAccount = {
      ...typed,
      typedBy: { by: 'device', deviceId: 'd2', accountId: 'a2', account: 'Sam', own: false }
    }
    expect(chat([otherAccount, OWNER_SEND])).toEqual(dana)
    const { account: _unnamed, ...nameless } = otherAccount.typedBy
    expect(chat([{ ...typed, typedBy: nameless }, OWNER_SEND])).toEqual(dana)
    // An event automation's prompt acts for its conversation.
    expect(chat([{ ...typed, memorySource: 'Webhook deploys' }, { origin: 'host' }])).toEqual(dana)
  })

  it('leaves an automation run the owner’s, as before', () => {
    const run = {
      ...typed,
      origin: 'automation-run',
      automationRun: { automationId: 'a1', runId: 'r1', name: 'Daily digest' }
    }
    expect(chat([run, { origin: 'host' }])).toEqual({ owner: true, line: null })
  })
})
