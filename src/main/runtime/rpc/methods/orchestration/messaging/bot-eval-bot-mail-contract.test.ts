// The bot eval's stand-in (src/cli/bot-orchestration-eval/bot-orchestration-eval-bots.ts) must refuse
// and answer mail to a bot as the real host does, or a bot is graded against rules that don't exist.
// Each case runs against both: the real orchestration.send with two bots, and the stand-in.
import '../../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../../shared/bot-types'
import type { BotRequestAsker } from '../../../../../../shared/bots/bot-acts-for'
import { makeTestBot } from '../../../../../bots/bot.test-fixture'
import type { EvalHostState } from '../../../../../../cli/bot-automation-eval/bot-automation-eval-host'
import { sendToBot } from '../../../../../../cli/bot-orchestration-eval/bot-orchestration-eval-bots'
import { OWNER_SLACK_ID } from '../../../../../../cli/bot-automation-eval/bot-automation-eval-slack'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type * as RecipientRouting from './recipient-routing'
import {
  askedBy,
  DOCS_REQUEST,
  journals,
  message,
  RANGER_THREAD,
  sessionsOf,
  setupBotMail,
  withChat
} from './bot-recipient.test-fixture'

vi.mock(
  '../../../../../bots/bot-session-tabs',
  async () => (await import('./bot-recipient.test-fixture')).botSessionTabsMock
)
vi.mock(
  '../../../../../bots/bot-chat-session',
  async () => (await import('./bot-recipient.test-fixture')).botChatSessionMock
)
vi.mock(
  '../../../../../bots/bot-chat-mail-hold',
  async () => (await import('./bot-recipient.test-fixture')).botChatMailHoldMock
)
vi.mock(
  '../../../../../bots/bot-chat-status-line',
  async () => (await import('./bot-recipient.test-fixture')).botChatStatusLineMock
)
vi.mock('./recipient-routing', async (importOriginal) =>
  (await import('./bot-recipient.test-fixture')).recipientRoutingMock(
    await importOriginal<typeof RecipientRouting>()
  )
)

type Case = {
  name: string
  /** Who asked Ranger: a Slack member by name, the owner in Slack, or the owner in their Chat. */
  asker?: 'Dana' | 'Nora' | 'Owner'
  /** Earlier sends in the same request. */
  before?: { to: string; type: string }[]
  send: { to: string; type?: string }
  docs?: Partial<Bot>
  wokenByDocs?: true
}

const CASES: Case[] = [
  { name: 'an unknown name', send: { to: 'bot:Doc', type: 'handoff' } },
  { name: 'a paused bot', send: { to: 'bot:Docs', type: 'handoff' }, docs: { paused: true } },
  { name: 'itself', send: { to: 'bot:Ranger', type: 'handoff' } },
  { name: 'another type', send: { to: 'bot:Docs', type: 'status' } },
  { name: 'no type', send: { to: 'bot:Docs' } },
  { name: 'an asker it does not take', asker: 'Nora', send: { to: 'bot:Docs', type: 'handoff' } },
  { name: 'an asker it takes', asker: 'Dana', send: { to: 'bot:docs', type: 'question' } },
  { name: "the owner's handoff", send: { to: 'bot:Docs', type: 'handoff' } },
  {
    name: "the owner's handoff from Slack",
    asker: 'Owner',
    send: { to: 'bot:Docs', type: 'handoff' }
  },
  { name: 'passing a request on', wokenByDocs: true, send: { to: 'bot:Three', type: 'handoff' } },
  {
    name: "passing a teammate's request on",
    asker: 'Nora',
    wokenByDocs: true,
    send: { to: 'bot:Three', type: 'question' }
  },
  {
    name: 'a repeated handoff',
    before: [{ to: 'bot:Docs', type: 'handoff' }],
    send: { to: 'bot:Docs', type: 'handoff' }
  },
  {
    name: 'a fourth bot',
    before: [
      { to: 'bot:Docs', type: 'question' },
      { to: 'bot:Three', type: 'question' },
      { to: 'bot:Four', type: 'question' }
    ],
    send: { to: 'bot:Five', type: 'question' }
  }
]

const USERS = { Dana: 'U_DANA', Nora: 'U_NORA', Owner: OWNER_SLACK_ID }

/** Whom Docs's request that woke Ranger was for: the case's Slack asker, else the owner. */
function wokenAskers(entry: Case): BotRequestAsker[] {
  const { asker } = entry
  return asker
    ? [
        {
          kind: 'person',
          source: 'slack',
          userId: USERS[asker],
          name: asker,
          workspaceId: 'T0EVAL',
          role: asker === 'Owner' ? 'owner' : 'member'
        }
      ]
    : [{ kind: 'owner' }]
}

/** What either host answered, with ids taken out. */
async function outcome(run: () => unknown): Promise<unknown> {
  try {
    const receipt = JSON.parse(JSON.stringify(await run()))
    const view = receipt.message?.payload ? JSON.parse(receipt.message.payload).botRequest : null
    return {
      next: receipt.next,
      duplicate: receipt.duplicate === true,
      type: receipt.message?.type,
      view: view ? { ...view, answer: undefined, ifThePostIsRefused: undefined } : null
    }
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) }
  }
}

describe('the stand-in sends to bots as the runtime does', () => {
  const h = createOrchestrationRpcHarness()
  let real: ReturnType<typeof setupBotMail>

  beforeEach(() => {
    real = setupBotMail(h)
    // The stand-in's bot sends from its Home Chat.
    real.bots[0] = { ...real.bots[0]!, chatSessionId: RANGER_THREAD }
    real.bots.push(
      makeTestBot({ id: 'b3', name: 'Three' }),
      makeTestBot({ id: 'b4', name: 'Four' }),
      makeTestBot({ id: 'b5', name: 'Five' })
    )
    for (const id of ['b3', 'b4', 'b5']) {
      sessionsOf[id] = [`55555555-5555-4555-8555-55555555555${id.slice(1)}`]
    }
    withChat.mockImplementation((botId: string, work: (sessionId: string) => unknown) =>
      work(sessionsOf[botId]![0]!)
    )
  })
  afterEach(() => h.cleanup())

  for (const entry of CASES) {
    it(entry.name, async () => {
      Object.assign(real.bots[1]!, entry.docs ?? {})
      const asker = entry.asker
        ? askedBy(USERS[entry.asker], entry.asker, entry.asker === 'Owner' ? 'owner' : 'member')
        : {}
      journals[RANGER_THREAD] = [
        entry.wokenByDocs
          ? message('woken', { from: { kind: 'agent', senders: [], orchestration: null } })
          : message('ask', asker)
      ]
      if (entry.wokenByDocs) {
        // Docs's request woke Ranger: stored as Docs sent it.
        const request = real.db.admitBotRequest({
          rootKey: 'docs-root',
          fromBotId: 'docs',
          toBotId: 'ranger',
          purpose: 'handoff',
          depth: 1,
          record: JSON.stringify({ askers: wokenAskers(entry) }),
          message: { from: `orca_session_id:${DOCS_REQUEST}`, to: 'x', subject: 'docs task' }
        })
        journals[RANGER_THREAD] = [
          message('woken', {
            from: {
              kind: 'agent',
              senders: [],
              orchestration: {
                message: 'mail-notice',
                mailbox: 'x',
                dispatchId: null,
                messages: [
                  {
                    messageId: request.kind === 'sent' ? request.message.id : '',
                    runId: 'r',
                    from: 'x'
                  }
                ]
              }
            }
          })
        ]
      }
      for (const earlier of entry.before ?? []) {
        await real.send(RANGER_THREAD, earlier)
      }
      const fromRuntime = await outcome(() => real.send(RANGER_THREAD, entry.send))

      const state: EvalHostState = {
        bots: real.bots.map((bot) => ({
          ...bot,
          members: bot.members.map((member) => ({ ...member, workspaceId: 'T0EVAL' }))
        })),
        automations: [],
        repos: [],
        timezone: 'UTC',
        ...(entry.asker
          ? {
              conversation: {
                source: 'slack',
                title: 't',
                asker: USERS[entry.asker],
                askerName: entry.asker,
                slack: { channel: 'C1', thread: '1712.1' }
              }
            }
          : {}),
        ...(entry.wokenByDocs ? { actingOnRequest: { depth: 1, askers: wokenAskers(entry) } } : {})
      }
      // The stand-in's bot is Ranger too.
      state.bots[0] = { ...state.bots[0]!, id: 'bot-ranger' }
      for (const earlier of entry.before ?? []) {
        sendToBot(state, { subject: 's', ...earlier })
      }
      const fromStandIn = await outcome(
        () => sendToBot(state, { subject: 's', ...entry.send }).receipt
      )
      expect(fromStandIn).toEqual(fromRuntime)
    })
  }
})
