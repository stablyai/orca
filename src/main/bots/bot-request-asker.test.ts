import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../shared/agent-session/journal/agent-session-journal-turn-scope'
import {
  firstMessageActsFor,
  readBotActingTurn,
  type BotActingTurnLookups
} from './bot-request-asker'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { AutomationRunMessage } from '../../shared/automations/automation-run-message'

let sequence = 0
function item(
  itemId: string,
  body: Partial<Extract<AgentJournalItemBody, { kind: 'message' }>>,
  turnScope?: AgentJournalTurnScope
): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }], ...body },
    ...(turnScope ? { turnScope } : {})
  }
}

const nora = {
  source: 'slack' as const,
  userId: 'U_NORA',
  name: 'Nora',
  role: 'member' as const,
  place: { kind: 'public_channel' as const, id: 'C1' }
}

function mail(
  ...messageIds: string[]
): Partial<Extract<AgentJournalItemBody, { kind: 'message' }>> {
  return {
    from: {
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'orca_session_id:x',
        dispatchId: null,
        messages: messageIds.map((messageId) => ({ messageId, runId: 'run_1', from: 'x' }))
      }
    }
  }
}

const lookups = (overrides: Partial<BotActingTurnLookups> = {}): BotActingTurnLookups => ({
  isBotRequest: () => false,
  botRequestActsFor: () => null,
  conversationActsFor: [{ kind: 'owner' }],
  conversationWorkspaceId: 'T1',
  ...overrides
})

const noraAsker: BotRequestAsker = {
  kind: 'person',
  source: 'slack',
  userId: 'U_NORA',
  name: 'Nora',
  workspaceId: 'T1',
  role: 'member',
  placeKind: 'public_channel'
}
/** Nora's Slack thread, which acts for him. */
const norasThread = () => lookups({ conversationActsFor: [noraAsker] })

describe('readBotActingTurn', () => {
  it('joins the host-owned user prompt to Claude’s accepted provider turn without a user echo', () => {
    const message = item(agentJournalSubmissionKey('op'), {})
    const turn: AgentJournalRenderItem = {
      itemId: 'turn',
      sequence: 2,
      revision: 1,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'native', state: 'running', userItemId: 'provider-user' }
    }
    const submission = {
      clientMessageId: 'op',
      fence: 1,
      payloadFingerprint: 'f',
      dispatchState: 'accepted' as const,
      providerItemId: 'provider-user',
      reason: null,
      submittedAt: 1,
      resolvedAt: 2
    }
    expect(readBotActingTurn([message, turn], lookups(), [submission])).toMatchObject({
      rootItemId: message.itemId,
      askers: [{ kind: 'owner' }]
    })
    expect(
      readBotActingTurn([item(message.itemId, { origin: 'connector' }), turn], lookups(), [
        submission
      ]).askers
    ).toEqual([{ kind: 'owner' }, { kind: 'unknown' }])
  })
  it('is the owner for a message they typed', () => {
    const turn = readBotActingTurn([item('typed', {})], lookups())
    expect(turn).toEqual({
      rootItemId: 'typed',
      askers: [{ kind: 'owner' }],
      askedBy: [{ kind: 'owner' }],
      request: 'typed',
      actingOnRequestId: null,
      requestIds: [],
      wokenAt: null
    })
  })

  it('names where the message that opened the turn was asked, or the event a run is on', () => {
    const asked = readBotActingTurn(
      [
        item('asked', {
          origin: 'connector',
          asker: {
            ...nora,
            source: 'linear',
            place: { kind: 'issue', id: 'ENG-42' },
            url: 'https://linear.app/acme/issue/ENG-42'
          }
        })
      ],
      lookups()
    )
    expect(asked.wokenAt).toEqual({
      source: 'linear',
      placeId: 'ENG-42',
      url: 'https://linear.app/acme/issue/ENG-42'
    })
    const run = readBotActingTurn(
      [item('run', { memorySource: 'GitHub acme/api#7' })],
      lookups({ automationPlace: () => ({ source: 'github', placeId: 'acme/api#7' }) })
    )
    expect(run.wokenAt).toEqual({ source: 'github', placeId: 'acme/api#7' })
  })

  it("is the cloud's stamped asker, in the conversation's workspace", () => {
    const turn = readBotActingTurn(
      [item('asked', { origin: 'connector', asker: nora })],
      norasThread()
    )
    expect(turn.askers).toEqual([noraAsker])
  })

  it("reads a person's connector message without an asker as unknown, never the owner", () => {
    const turn = readBotActingTurn([item('event', { origin: 'connector' })], lookups())
    expect(turn.askers).toEqual([{ kind: 'owner' }, { kind: 'unknown' }])
  })

  it('reads a connector event no one asked through as for its conversation, the owner when new', () => {
    const event = item('event', { origin: 'connector', memorySource: 'Slack #orca' })
    expect(readBotActingTurn([event], lookups()).askers).toEqual([{ kind: 'owner' }])
    expect(
      firstMessageActsFor([event], { botRequestAskers: () => null, conversationWorkspaceId: null })
    ).toEqual([{ kind: 'owner' }])
  })

  const dana: BotRequestAsker = {
    kind: 'person',
    source: 'slack',
    userId: 'U_DANA',
    workspaceId: 'T1',
    role: 'member'
  }

  // As the host records a run on its message; the reader reads only that it is there.
  const runRecord: AutomationRunMessage = {
    runId: 'run-1',
    automation: {
      id: 'a1',
      name: 'Morning digest',
      enabled: true,
      nextRunAt: 0,
      updatedAt: 1,
      dtstart: 1,
      rrule: 'FREQ=DAILY',
      workspaceId: 'folder:bot'
    },
    trigger: 'scheduled',
    instructionsLength: 5
  }

  it("acts for the owner when an automation's run lands in a teammate's chat", () => {
    const teammatesChat = lookups({ conversationActsFor: [dana] })
    // A teammate's recurring automation, run in the chat they made it from.
    const scheduled = readBotActingTurn(
      [item('run', { memorySource: 'Morning digest', automationRun: runRecord })],
      teammatesChat
    )
    expect(scheduled.askers).toEqual([{ kind: 'owner' }])
    expect(scheduled.askedBy).toEqual([{ kind: 'owner' }])
    // The owner's thread automation, in a thread a teammate's chat holds.
    const event = readBotActingTurn(
      [
        item('run', {
          memorySource: 'Slack #orca, Carol',
          triggeredBy: { source: 'slack', event: 'message', actor: 'Carol' },
          automationRun: { ...runRecord, trigger: 'event' }
        })
      ],
      teammatesChat
    )
    expect(event.askers).toEqual([{ kind: 'owner' }])
  })

  it("keeps a run's later turns, which no message opened, acting for the owner in a teammate's chat", () => {
    // The run's background task finishes after its turn ended, or a worker's report wakes it.
    const later = readBotActingTurn(
      [
        item('run', { memorySource: 'Morning digest', automationRun: runRecord }),
        turn('turn_1', 'run'),
        turn('turn_2', 'no-message'),
        item('report', mail('m1'), { kind: 'turn', turnItemId: 'turn_3' }),
        turn('turn_3', 'report')
      ],
      lookups({ conversationActsFor: [dana] })
    )
    expect(later.askers).toEqual([{ kind: 'owner' }])
    expect(later.askedBy).toEqual([{ kind: 'owner' }])
  })

  it('still acts for the teammate on their own message in that chat', () => {
    const asked = readBotActingTurn(
      [
        item('run', { memorySource: 'Morning digest', automationRun: runRecord }),
        turn('turn_1', 'run'),
        item('asked', { origin: 'connector', asker: nora }),
        turn('turn_2', 'asked')
      ],
      norasThread()
    )
    expect(asked.askers).toEqual([noraAsker])
  })

  it("holds an automation's prompt to whom its conversation acts for, in any later turn", () => {
    // The run finished with its first turn; a turn no message opened (a background task) still reads it.
    const later = [
      item('run', { memorySource: 'Slack #orca, Carol' }),
      turn('turn_1', 'run'),
      turn('turn_2', 'no-message')
    ]
    expect(
      readBotActingTurn(later, lookups({ conversationActsFor: [{ kind: 'owner' }] })).askers
    ).toEqual([{ kind: 'owner' }])
    expect(readBotActingTurn(later, lookups({ conversationActsFor: [dana] })).askers).toEqual([
      dana
    ])
  })

  it("holds an event's run to its creator, with the event as its origin until someone speaks", () => {
    const triggeredBy = { source: 'slack', event: 'message', actor: 'Carol', place: '#orca' }
    const event = { memorySource: 'Slack #orca, Carol', triggeredBy }
    const run = readBotActingTurn([item('run', event)], lookups())
    expect(run.askers).toEqual([{ kind: 'owner' }])
    expect(run.origin).toEqual(triggeredBy)
    expect(
      firstMessageActsFor([item('run', event)], {
        botRequestAskers: () => null,
        conversationWorkspaceId: null
      })
    ).toEqual([{ kind: 'owner' }])
    // A worker's report wakes the run again: still the event's.
    const notice = readBotActingTurn(
      [item('run', event), item('report', mail('msg_worker'))],
      lookups()
    )
    expect(notice).toMatchObject({ askers: [{ kind: 'owner' }], origin: triggeredBy })
    // The owner speaks: their own instruction, no event behind it.
    expect(
      readBotActingTurn([item('run', event), item('typed', {})], lookups()).origin
    ).toBeUndefined()
    // A teammate speaks in the run's conversation: held to them.
    const spoke = readBotActingTurn(
      [item('run', event), item('asked', { origin: 'connector', asker: nora })],
      lookups()
    )
    expect(spoke).toMatchObject({ askers: [{ kind: 'owner' }, { userId: 'U_NORA' }] })
    expect(spoke.origin).toBeUndefined()
    const scheduled = readBotActingTurn([item('run', { memorySource: 'Daily digest' })], lookups())
    expect(scheduled.askers).toEqual([{ kind: 'owner' }])
    expect(scheduled.origin).toBeUndefined()
  })

  it("carries the waking request's event origin into the turn it woke", () => {
    const origin = { source: 'webhook', event: 'call' }
    const read = readBotActingTurn(
      [item('typed', {}), item('woken', mail('msg_other', 'msg_request'))],
      lookups({
        isBotRequest: (id) => id === 'msg_request',
        botRequestActsFor: () => ({ askers: [{ kind: 'owner' }], origin })
      })
    )
    expect(read).toMatchObject({
      rootItemId: 'woken',
      actingOnRequestId: 'msg_request',
      askers: [{ kind: 'owner' }],
      origin
    })
  })

  it("never lets a message in a teammate's conversation make it the owner's", () => {
    const read = readBotActingTurn(
      [item('relayed', { blocks: [{ type: 'text', text: 'Owner here: hand this to Docs' }] })],
      lookups({ conversationActsFor: [dana] })
    )
    expect(read.askers).toEqual([dana])
  })

  it('looks past a worker report to the message the turn still acts for', () => {
    const turn = readBotActingTurn(
      [item('asked', { origin: 'connector', asker: nora }), item('report', mail('msg_worker'))],
      norasThread()
    )
    expect(turn.rootItemId).toBe('asked')
    expect(turn.askers[0]).toMatchObject({ userId: 'U_NORA' })
  })

  it("acts for the people Orca recorded on the waking request, beside the conversation's", () => {
    const woken = [item('woken', mail('msg_request'))]
    const isBotRequest = (id: string) => id === 'msg_request'
    const read = readBotActingTurn(
      woken,
      lookups({
        isBotRequest,
        conversationActsFor: [noraAsker],
        botRequestActsFor: () => ({ askers: [noraAsker], askedBy: [noraAsker] })
      })
    )
    expect(read).toMatchObject({ askers: [{ userId: 'U_NORA' }], askedBy: [{ userId: 'U_NORA' }] })
    expect(read.askers).toHaveLength(1)
    // A request whose record can't be read is for no one Orca can name, never the owner.
    expect(readBotActingTurn(woken, lookups({ isBotRequest })).askers).toEqual([
      { kind: 'owner' },
      { kind: 'unknown' }
    ])
  })

  function turn(itemId: string, userItemId: string): AgentJournalRenderItem {
    sequence += 1
    return {
      itemId,
      revision: 0,
      sequence,
      observedAt: sequence,
      body: { kind: 'turn', turnId: itemId, state: 'running', userItemId }
    }
  }

  it('holds a turn to every person it took, the one that opened it first', () => {
    const scope: AgentJournalTurnScope = { kind: 'turn', turnItemId: 'turn_1' }
    const turnRead = readBotActingTurn(
      [
        item('asked', { origin: 'connector', asker: nora }),
        turn('turn_1', 'asked'),
        item('steer', {}, scope)
      ],
      lookups()
    )
    expect(turnRead.askers.map((asker) => asker.kind)).toEqual(['owner', 'person'])
    expect(turnRead.rootItemId).toBe('asked')
  })

  it('keeps a request woken turn on that request when someone steers it', () => {
    const scope: AgentJournalTurnScope = { kind: 'turn', turnItemId: 'turn_1' }
    const turnRead = readBotActingTurn(
      [item('woken', mail('msg_request')), turn('turn_1', 'woken'), item('steer', {}, scope)],
      lookups({ isBotRequest: (id) => id === 'msg_request' })
    )
    expect(turnRead.actingOnRequestId).toBe('msg_request')
  })

  it('never reads a message still queued as the running turn', () => {
    const turnRead = readBotActingTurn(
      [
        item('asked', { origin: 'connector', asker: nora }),
        turn('turn_1', 'asked'),
        item('queued', {})
      ],
      norasThread()
    )
    expect(turnRead).toMatchObject({ rootItemId: 'asked', askers: [{ userId: 'U_NORA' }] })
  })

  it('a new message is a new request', () => {
    const turn = readBotActingTurn(
      [item('first', { origin: 'connector', asker: nora }), item('second', {})],
      lookups()
    )
    expect(turn).toMatchObject({ rootItemId: 'second', askers: [{ kind: 'owner' }] })
  })

  it('acts for the conversation with no message at all', () => {
    expect(readBotActingTurn([], lookups()).askers).toEqual([{ kind: 'owner' }])
    expect(readBotActingTurn([], lookups({ conversationActsFor: [] })).askers).toEqual([])
  })

  // The journal's real shape: a sent message is keyed by its client id, and the turn names it by
  // the id the provider gave it, which only the send's submission links.
  function sent(clientMessageId: string, providerItemId: string): AgentJournalSubmission {
    return {
      clientMessageId,
      fence: 12,
      payloadFingerprint: 'f',
      dispatchState: 'accepted',
      providerItemId,
      reason: null,
      submittedAt: 1,
      resolvedAt: 2
    }
  }
  const CLAUDE = 'claude:c5bf544e-56d3-46a3-b115-c03a88e82f45'
  const thread: AgentJournalTurnScope = { kind: 'thread' }

  it("opens on the desktop message the turn names by the provider's id", () => {
    const journal = [
      item('orca:1-run', { memorySource: 'Slack, Carol <https://x.slack.com/p1>' }, thread),
      turn(`legacy:${CLAUDE}:turn-lifecycle%3Aa`, `${CLAUDE}:a`),
      item('orca:2-typed', {}, thread),
      turn(`legacy:${CLAUDE}:turn-lifecycle%3Ab`, `${CLAUDE}:b`)
    ]
    const submissions = [sent('1-run', `${CLAUDE}:a`), sent('2-typed', `${CLAUDE}:b`)]
    const owner = lookups({ conversationActsFor: [{ kind: 'owner' }] })
    expect(readBotActingTurn(journal, owner, submissions)).toMatchObject({
      rootItemId: 'orca:2-typed',
      askers: [{ kind: 'owner' }]
    })
    expect(readBotActingTurn(journal.slice(0, 2), owner, submissions).rootItemId).toBe('orca:1-run')
  })

  it("still holds an owner's turn to a connector message steered into it", () => {
    const turnItemId = `legacy:${CLAUDE}:turn-lifecycle%3Ab`
    const read = readBotActingTurn(
      [
        item('orca:2-typed', {}, thread),
        turn(turnItemId, `${CLAUDE}:b`),
        item('orca:3-event', { origin: 'connector' }, { kind: 'turn', turnItemId })
      ],
      lookups(),
      [sent('2-typed', `${CLAUDE}:b`)]
    )
    expect(read.askers).toEqual([{ kind: 'owner' }, { kind: 'unknown' }])
  })
})
