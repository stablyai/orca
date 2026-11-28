import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { botWakesInARow } from './bot-chain-messages'
import { readBotActingTurn, type BotActingTurnLookups } from './bot-request-asker'

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

const nora = {
  source: 'slack' as const,
  userId: 'U_NORA',
  name: 'Nora',
  role: 'member' as const,
  place: { kind: 'public_channel' as const, id: 'C1' }
}

function mail(messageId: string): Partial<Extract<AgentJournalItemBody, { kind: 'message' }>> {
  return {
    from: {
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'orca_session_id:x',
        dispatchId: null,
        messages: [{ messageId, runId: 'run_1', from: 'x' }]
      }
    }
  }
}

const lookups: BotActingTurnLookups = {
  isBotRequest: (id) => id === 'msg_request',
  botRequestActsFor: () => null,
  conversationActsFor: [{ kind: 'owner' }],
  conversationWorkspaceId: 'T1'
}

const scope: AgentJournalTurnScope = { kind: 'turn', turnItemId: 'turn_1' }
/** A turn a bot request woke, with `joined` steered into it. */
const wokenTurnWith = (joined: Partial<Extract<AgentJournalItemBody, { kind: 'message' }>>) =>
  readBotActingTurn(
    [item('woken', mail('msg_request')), turn('turn_1', 'woken'), item('joined', joined, scope)],
    lookups
  )

describe("a request's turn and its chain", () => {
  it("starts a new chain when the owner's own words join the turn", () => {
    const turnRead = wokenTurnWith({})
    expect(turnRead.actingOnRequestId).toBe('msg_request')
    expect(turnRead.personJoined).toBe(true)
  })

  it("never starts a new chain for another Orca bot's post that joins a request's turn", () => {
    const botPost = {
      origin: 'connector' as const,
      asker: { ...nora, via: { userId: 'UB', name: 'Docs' } }
    }
    expect(wokenTurnWith(botPost).personJoined).toBeUndefined()
  })

  it("never starts a new chain for another Slack app's post that joins a request's turn", () => {
    const appPost = { origin: 'connector' as const, asker: { ...nora, app: true as const } }
    expect(wokenTurnWith(appPost).personJoined).toBeUndefined()
  })

  it('never starts a new chain for an agent typing through the orca CLI', () => {
    expect(wokenTurnWith({ typedBy: { by: 'agent' } }).personJoined).toBeUndefined()
  })
})

describe('botWakesInARow', () => {
  const botPost = (id: string) =>
    item(id, { origin: 'connector', asker: { ...nora, via: { userId: 'UB', name: 'Docs' } } })

  it("counts other bots' posts back to a person's own message, past mail and automation prompts", () => {
    const items = [
      botPost('old'),
      item('owner', {}),
      botPost('b1'),
      item('mail', mail('m1')),
      item('run', { memorySource: 'Automation Nightly' }),
      botPost('b2')
    ]
    expect(botWakesInARow(items, 12)).toEqual({ wakes: 2, decided: true })
  })

  it("neither resets nor counts on another Slack app's post", () => {
    const appPost = item('lint', { origin: 'connector', asker: { ...nora, app: true } })
    expect(botWakesInARow([botPost('b1'), appPost, botPost('b2')], 12)).toEqual({
      wakes: 2,
      decided: false
    })
  })

  it("resets on a person's Slack message, and stops counting at the limit", () => {
    expect(
      botWakesInARow([botPost('b1'), item('nora', { origin: 'connector', asker: nora })], 12)
    ).toEqual({ wakes: 0, decided: true })
    const posts = Array.from({ length: 14 }, (_, index) => botPost(`b${index}`))
    expect(botWakesInARow(posts, 12)).toEqual({ wakes: 12, decided: true })
    expect(botWakesInARow(posts.slice(0, 3), 12)).toEqual({ wakes: 3, decided: false })
  })
})
