import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { actsForOwner, OWNER_ACTS_FOR, type BotRequestAsker } from '../../shared/bots/bot-acts-for'
import { askedByLine } from './bot-owner-writes'
import { requestAskersOf } from './bot-request-askers-of'
import { botRequestAskerLabel, botRequestView } from './bot-request-view'
import { connectorAskerHeader } from '../../shared/connector-asker-prompt'
import { ConnectorAsker } from '../../shared/connector-asker-contract'
import { storedConnectorAsker } from '../../shared/connector-message-asker'
import { connectorAskerTagView } from '../../shared/connectors/connector-message-asker-view'
import {
  firstMessageActsFor,
  readBotActingTurn,
  turnActsForOwner,
  type BotActingTurnLookups,
  type BotRequestActsFor
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
const message = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'read my DMs' }] }
// The owner's send at the host's own window.
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
const workerMail = {
  ...typed,
  from: {
    sessionId: 'worker-1',
    orchestration: { message: 'mail-notice', messages: [{ messageId: 'mail-1' }] }
  }
}
// A paired phone or computer that declares the host's own account.
const sameAccountDevice = {
  ...message,
  typedBy: { by: 'device', deviceId: 'd1', accountId: 'a1', account: 'Me', own: true }
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

type Turn = [unknown, Sent | null, unknown[]?]

/** Dana's finished Slack turn, then the turns given as [opener, how it was sent, steered in]; a null
 *  opener is a turn no message opened. */
function chat(...turns: Turn[]) {
  return chatActingFor([DANA], fromDana, turns)
}

/** The owner's chat (Home Chat, or one the owner started): the owner's finished turn, then `turns`. */
function ownerChat(...turns: Turn[]) {
  return chatActingFor(OWNER_ACTS_FOR, typed, turns)
}

function chatActingFor(
  conversationActsFor: readonly BotRequestAsker[],
  first: unknown,
  turns: Turn[]
) {
  const turn = readChat(conversationActsFor, first, turns)
  return {
    owner: turnActsForOwner(turn),
    line: askedByLine({ bot: { name: 'Scout' }, turn, inConversation: true })
  }
}

function readChat(conversationActsFor: readonly BotRequestAsker[], first: unknown, turns: Turn[]) {
  seq = 0
  const items = [
    journalRow('u0', first),
    journalRow('t0', { kind: 'turn', turnId: 'p0', state: 'completed', userItemId: 'u0' })
  ]
  const submissions: AgentJournalSubmission[] = []
  turns.forEach(([opener, sent, steered = []], index) => {
    const n = index + 1
    items.push(
      ...(opener === null ? [] : [journalRow(`u${n}`, opener)]),
      journalRow(`t${n}`, {
        kind: 'turn',
        turnId: `p${n}`,
        state: 'running',
        ...(opener === null ? {} : { userItemId: `u${n}` })
      }),
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
  return readBotActingTurn(items, { ...lookups, conversationActsFor }, submissions)
}

/** Home Chat's turn holding a bot request (`record` as Orca keeps it): opened by the request, or
 *  by the owner's own message typed at the host when `ownerOpened`, with a paired device's message
 *  Orca can't place as the owner steered in when `steered`. */
function requestTurn(record: BotRequestActsFor, steered: boolean, ownerOpened = false) {
  seq = 0
  const request = {
    ...message,
    from: {
      sessionId: 'asker',
      orchestration: { message: 'mail-notice', messages: [{ messageId: 'req-1' }] }
    }
  }
  const scoped = { turnScope: { kind: 'turn' as const, turnItemId: 't1' } }
  const items = [
    journalRow('u1', ownerOpened ? typed : request),
    journalRow('t1', { kind: 'turn', turnId: 'p1', state: 'running', userItemId: 'u1' }),
    ...(ownerOpened ? [journalRow('r1', request, scoped)] : []),
    ...(steered
      ? [journalRow('s1', { ...message, typedBy: { by: 'device', deviceId: 'd4' } }, scoped)]
      : [])
  ]
  // The owner's message, as the journal reads a person's send.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a submission with only the fields the reader reads.
  const sent = {
    clientMessageId: 'c1',
    providerItemId: 'u1',
    ...OWNER_SEND
  } as AgentJournalSubmission
  return readBotActingTurn(
    items,
    {
      ...lookups,
      conversationActsFor: OWNER_ACTS_FOR,
      isBotRequest: (id) => id === 'req-1',
      botRequestActsFor: () => record
    },
    ownerOpened ? [sent] : []
  )
}

// Hardcoded: whom a turn on a chat Dana started acts for, as Slack actions and owner writes read it.
describe('a turn the owner typed in Orca', () => {
  it('acts for the owner though the chat acts for a teammate', () => {
    expect(chat([typed, OWNER_SEND])).toEqual({ owner: true, line: null })
  })

  it('takes a paired device’s account as a claim: never over the teammate the chat acts for', () => {
    // A device that declares the host's own account: its say-so, not proof it is the owner.
    expect(chat([sameAccountDevice, OWNER_SEND])).toEqual({
      owner: false,
      line: 'asked by Dana via Scout'
    })
    expect(chat([typed, OWNER_SEND, [sameAccountDevice]]).owner).toBe(false)
    // The owner's own phone or computer in the owner's chats still acts for the owner.
    expect(ownerChat([sameAccountDevice, OWNER_SEND])).toEqual({ owner: true, line: null })
    expect(ownerChat([typed, OWNER_SEND])).toEqual({ owner: true, line: null })
  })

  it('stays the teammate’s when anyone but the owner typing opened or joined it', () => {
    const dana = { owner: false, line: 'asked by Dana via Scout' }
    expect(chat([fromDana, null])).toEqual(dana)
    expect(chat([typed, OWNER_SEND, [fromDana]])).toEqual(dana)
    // A worker's report or item mail reads back to the owner's turn before it, never as the owner's.
    expect(chat([typed, OWNER_SEND], [workerMail, null])).toEqual(dana)
    // Nor does a turn no message opened borrow the owner's message before it.
    expect(chat([typed, OWNER_SEND], [null, null])).toEqual(dana)
    // Orca's continue after a restart, an agent's send and another account's paired computer.
    expect(chat([typed, { origin: 'host' }])).toEqual(dana)
    expect(chat([{ ...typed, typedBy: { by: 'agent' } }, OWNER_SEND])).toEqual(dana)
    const otherAccount = {
      ...typed,
      typedBy: { by: 'device', deviceId: 'd2', accountId: 'a2', account: 'Sam', own: false }
    }
    expect(chat([otherAccount, OWNER_SEND])).toEqual(dana)
    // Anything Orca can't place as the owner is not: another account unnamed, an account it couldn't
    // compare, or no stamp at all.
    const { account: _unnamed, ...nameless } = otherAccount.typedBy
    expect(chat([{ ...message, typedBy: nameless }, OWNER_SEND])).toEqual(dana)
    const uncompared = { by: 'device', deviceId: 'd3', accountId: 'a3', account: 'Me' }
    expect(chat([{ ...message, typedBy: uncompared }, OWNER_SEND])).toEqual(dana)
    expect(chat([message, OWNER_SEND])).toEqual(dana)
    // An event automation's prompt acts for its conversation.
    expect(chat([{ ...typed, memorySource: 'Webhook deploys' }, { origin: 'host' }])).toEqual(dana)
  })

  it('never acts for the owner when a device Orca can’t place as the owner typed in the turn', () => {
    const notOwner = { owner: false, line: null }
    const otherAccount = {
      ...message,
      typedBy: { by: 'device', deviceId: 'd2', accountId: 'a2', account: 'Sam', own: false }
    }
    // An account the host couldn't compare, and a device that declared none.
    const uncompared = {
      ...message,
      typedBy: { by: 'device', deviceId: 'd3', accountId: 'a3', account: 'Me' }
    }
    const unclaimed = { ...message, typedBy: { by: 'device', deviceId: 'd4' } }
    for (const device of [otherAccount, uncompared, unclaimed]) {
      // Home Chat, a chat the owner or a device started: the conversation's owner default is no proof.
      expect(ownerChat([device, OWNER_SEND])).toEqual(notOwner)
      // Steered into the owner's own turn.
      expect(ownerChat([typed, OWNER_SEND, [device]])).toEqual(notOwner)
      // A worker's report reads back to that turn, and stays not the owner's.
      expect(ownerChat([device, OWNER_SEND], [workerMail, null])).toEqual(notOwner)
      // A teammate's chat stays the teammate's.
      expect(chat([device, OWNER_SEND])).toEqual({ owner: false, line: 'asked by Dana via Scout' })
    }
    // The owner's input still acts for the owner: at the host, on their own account's device, or
    // unstamped from an older host.
    expect(ownerChat([typed, OWNER_SEND])).toEqual({ owner: true, line: null })
    expect(ownerChat([sameAccountDevice, OWNER_SEND])).toEqual({ owner: true, line: null })
    expect(ownerChat([message, OWNER_SEND])).toEqual({ owner: true, line: null })
    // A turn after the device's own acts for the owner again.
    expect(ownerChat([unclaimed, OWNER_SEND], [typed, OWNER_SEND])).toEqual({
      owner: true,
      line: null
    })
  })

  it('treats an agent’s CLI over a device’s pairing as that device', () => {
    const pairedAgent = { ...message, typedBy: { by: 'agent', deviceId: 'd5' } }
    expect(ownerChat([pairedAgent, null])).toEqual({ owner: false, line: null })
    const otherAgent = { ...message, typedBy: { by: 'agent', deviceId: 'd5', own: false } }
    expect(ownerChat([otherAgent, null])).toEqual({ owner: false, line: null })
    // The same claim rules as a person's device: the owner's account keeps the owner's chat.
    const ownAgent = { ...message, typedBy: { by: 'agent', deviceId: 'd5', own: true } }
    expect(ownerChat([ownAgent, null])).toEqual({ owner: true, line: null })
    // An agent on this host names no device: its own chat stays the owner's.
    expect(ownerChat([{ ...message, typedBy: { by: 'agent' } }, null])).toEqual({
      owner: true,
      line: null
    })
  })

  it('sends a request that never reads as the owner’s from a turn such a device typed in', () => {
    const unclaimed = { ...message, typedBy: { by: 'device', deviceId: 'd4' } }
    const askers = requestAskersOf(readChat(OWNER_ACTS_FOR, typed, [[unclaimed, OWNER_SEND]]))
    expect(askers).toEqual([{ kind: 'owner' }, { kind: 'unknown' }])
    expect(actsForOwner(askers)).toBe(false)
    // The receiving bot's new chat for that request acts for those askers, never the owner alone.
    const receiving = firstMessageActsFor(
      [
        journalRow('r1', {
          ...message,
          from: {
            sessionId: 'sender',
            orchestration: { message: 'mail-notice', messages: [{ messageId: 'req-1' }] }
          }
        })
      ],
      { botRequestAskers: () => askers, conversationWorkspaceId: null }
    )
    expect(actsForOwner(receiving ?? [])).toBe(false)
    // The receiving bot reads who asked as someone Orca can't name, never its owner; a mixed turn
    // keeps the owner it knows.
    const turn = readChat(OWNER_ACTS_FOR, typed, [[unclaimed, OWNER_SEND]])
    expect(turn.askedBy.map(botRequestAskerLabel)).toEqual(['someone Orca cannot name'])
    const mixed = readChat(OWNER_ACTS_FOR, typed, [[typed, OWNER_SEND, [unclaimed]]])
    expect(mixed.askedBy.map(botRequestAskerLabel)).toEqual([
      'your owner',
      'someone Orca cannot name'
    ])
    // The owner's own turn sends the owner's request, as before.
    expect(requestAskersOf(readChat(OWNER_ACTS_FOR, typed, [[typed, OWNER_SEND]]))).toEqual([
      { kind: 'owner' }
    ])
  })

  it('holds a turn a bot request opened to such a device steered into it', () => {
    // The owner's question, with the device's message steered in: both asked.
    const asked = requestTurn({ askers: [...OWNER_ACTS_FOR] }, true)
    expect(turnActsForOwner(asked)).toBe(false)
    expect(asked.askedBy.map(botRequestAskerLabel)).toEqual([
      'your owner',
      'someone Orca cannot name'
    ])
    // The owner's status asks for nothing: beside the device, only the device asked for work.
    const status = { askers: [...OWNER_ACTS_FOR], wantsNothing: true as const }
    const informed = requestTurn(status, true)
    expect(turnActsForOwner(informed)).toBe(false)
    expect(informed.askedBy.map(botRequestAskerLabel)).toEqual(['someone Orca cannot name'])
    // So a question that turn sends tells the bot it asks that the device asked, never the owner.
    const view = botRequestView(
      {
        fromBotId: 'scout',
        fromBotName: 'Scout',
        toBotId: 'helper',
        toBotName: 'Helper',
        purpose: 'question',
        depth: 1,
        askers: requestAskersOf(informed),
        askedBy: informed.askedBy,
        request: null,
        conversation: null
      },
      'm1'
    )
    expect(view.for).toBe('someone Orca cannot name')
    // The status alone still reads as the owner's, and acts for them.
    const statusAlone = requestTurn(status, false)
    expect(statusAlone.askedBy.map(botRequestAskerLabel)).toEqual(['your owner'])
    expect(turnActsForOwner(statusAlone)).toBe(true)
    // The owner typed the turn's own opener: they asked for its work, beside the device, though the
    // status that joined it asked for none.
    const ownerAndDevice = requestTurn(status, true, true)
    expect(turnActsForOwner(ownerAndDevice)).toBe(false)
    expect(ownerAndDevice.askedBy.map(botRequestAskerLabel)).toEqual([
      'your owner',
      'someone Orca cannot name'
    ])
    // The owner's own message with the status, no device: the owner asked, and it acts for them.
    const ownerAlone = requestTurn(status, false, true)
    expect(ownerAlone.askedBy.map(botRequestAskerLabel)).toEqual(['your owner'])
    expect(turnActsForOwner(ownerAlone)).toBe(true)
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
