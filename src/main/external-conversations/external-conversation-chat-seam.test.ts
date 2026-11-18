import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { finishTurn, failTurn } from './external-conversation-provider-turn.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOT_QUIET_MARKER } from '../../shared/bot-quiet-result'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import type { ExternalConversationBot } from '../../shared/connectors/external-conversation-link'
import {
  attach,
  hostTestState,
  seedApproval
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import type { ConversationBots } from './external-conversation-bots'
import { chatPaneKey, type ConversationChatHost } from './external-conversation-chat'
import type { ConversationEvent, ConversationSnapshot } from './external-conversation-events'
import { HOST_CLOCK, type ExternalConversationHost } from './external-conversation-host'
import { agentReady, harness, installedChats } from './external-conversation-seam.test-fixture'
import { WORKTREE } from './external-conversation.test-fixture'
import { refused, type ConversationKey } from './external-conversation-types'

// The seam over the real native-chat host: its own feed tells chat turns.
const KEY: ConversationKey = { source: 'slack', externalId: 'T1:C9:1:U5' }
const BOT_KEY: ConversationKey = { source: 'slack', externalId: 'T1:C9:2' }
const PANE = chatPaneKey(HOST_TEST_SESSION)
const THREAD_BOT: ExternalConversationBot = { kind: 'bot', botId: 'b1' }

function linkedSeam(
  chats: ConversationChatHost,
  bot?: ExternalConversationBot,
  workers?: ExternalConversationHost['workers'],
  bots?: ExternalConversationHost['bots'],
  key: ConversationKey = KEY,
  promptsAudience = false
) {
  const h = harness(undefined, undefined, { promptsAudience: () => promptsAudience })
  const host: ExternalConversationHost = {
    chat: chats,
    ...(workers ? { workers } : {}),
    ...(bots ? { bots } : {})
  }
  h.seam.linkChat(key, {
    worktreeId: WORKTREE,
    sessionId: HOST_TEST_SESSION,
    agent: 'codex',
    ...(bot ? { bot } : {})
  })
  const events: (ConversationEvent | ConversationSnapshot)[] = []
  const release = h.seam.watch(host, (event) => events.push(event))
  return { ...h, host, key, events, release }
}

/** A message from the thread, so the turn it starts is the thread's. */
async function fromThread(
  linked: Pick<ReturnType<typeof linkedSeam>, 'seam' | 'host' | 'key'>,
  key = linked.key
): Promise<void> {
  const bots = { refusal: () => null, open: vi.fn(), workLinks: async () => [] }
  // Sent before the turn it starts.
  const clock = vi.spyOn(HOST_CLOCK, 'now').mockReturnValue(400)
  const { dispatch } = hostTestState()
  const sent = dispatch.mock.calls.length
  await linked.seam.send({ bots, ...linked.host }, key, 'from-thread', { text: 'go' })
  clock.mockRestore()
  // The chat dispatches it from its delivery loop; the turn it starts follows.
  await eventually(() => expect(dispatch.mock.calls.length).toBeGreaterThan(sent))
}

/** A worker's report, as Orca sends it into a coordinating chat; `toConversation` when a turn its
 *  thread asked for started the worker. */
const workerReport = (toConversation: boolean): AgentMessageSource => ({
  kind: 'agent',
  senders: [
    {
      party: { address: 'dispatch:d1', terminalHandle: null, orcaSessionId: null },
      name: 'Worker',
      relation: 'worker',
      ...(toConversation ? { toConversation: true as const } : {})
    }
  ],
  orchestration: {
    message: 'mail-notice',
    mailbox: 'run:r1',
    dispatchId: null,
    messages: [{ messageId: 'm1', runId: 'r1', from: 'dispatch:d1' }]
  }
})
const MAIL_NOTICE = workerReport(true)

function chatRow(): AgentStatusIpcPayload {
  return {
    paneKey: PANE,
    tabId: 'tab',
    worktreeId: WORKTREE,
    connectionId: null,
    structuredHost: 'owned',
    state: 'working',
    prompt: 'ship it',
    agentType: 'codex',
    receivedAt: 500,
    stateStartedAt: 500
  }
}

/** The chat's status row says a turn began at `at`. */
function startTurnAt(
  h: Pick<ReturnType<typeof harness>, 'hookRows' | 'paneChange'>,
  at: number
): void {
  h.hookRows.set(PANE, { ...chatRow(), receivedAt: at, stateStartedAt: at })
  h.paneChange({
    kind: 'moved',
    paneKey: PANE,
    workspace: { worktreeId: WORKTREE, sshHostId: null },
    from: 'rest',
    to: 'working',
    at,
    transition: 'prompt-submitted'
  })
}

const ended = (events: (ConversationEvent | ConversationSnapshot)[]) =>
  events.filter((event) => event.kind === 'turn-ended')

beforeEach(() => {
  // The host refuses operation ids minted far from its own clock.
  vi.useFakeTimers({ toFake: ['Date'], now: HOST_TEST_NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a conversation linked to a native chat', () => {
  it('reports a new link, so a bot’s Activity shows its thread before any agent starts', () => {
    const { host } = hostTestState()
    const { linked, release } = linkedSeam(installedChats(host).chats)
    expect(linked.count).toBe(1)
    release()
  })

  // Typed in Orca, a turn is the owner's: no status, Stop or end reaches the thread.
  it.each([
    ['a thread', undefined, false],
    ['a bot’s thread', THREAD_BOT, false],
    // Claude's turn names its echo's id, an alias of the delivered message's row.
    ['a Claude bot’s thread', THREAD_BOT, true]
  ])(
    'tells %s nothing of a turn typed in Orca, and all of the next one it asks',
    async (_, bot, claudeEcho) => {
      const { host } = hostTestState()
      await attach()
      const { events, hookRows, paneChange, ...linked } = linkedSeam(
        installedChats(host).chats,
        bot
      )
      const startAt = (at: number) => startTurnAt({ hookRows, paneChange }, at)
      startAt(500)
      await finishTurn('Typed in Orca.')
      await fromThread(linked)
      startAt(900)
      await finishTurn('Asked from the thread.', { turnId: 'turn-2', claudeEcho })

      await eventually(() => expect(ended(events)).toHaveLength(1))
      expect(events.slice(1)).toEqual([
        expect.objectContaining({ kind: 'turn-started', at: 900, deliveryId: 'from-thread' }),
        expect.objectContaining({
          kind: 'turn-ended',
          turnId: 900,
          origin: 'delivery',
          lastAssistantMessage: 'Asked from the thread.'
        })
      ])
    }
  )

  it('tells the link, the start, and a delivered turn’s end with its last message', async () => {
    const { host } = hostTestState()
    await attach()
    const { seam, events, hookRows, paneChange, ...h } = linkedSeam(installedChats(host).chats)
    expect(events[0]).toMatchObject({
      kind: 'snapshot',
      conversations: [{ paneKey: PANE, agent: 'codex', working: false, prompt: null }]
    })

    // Sent before the turn it starts (at 500).
    const clock = vi.spyOn(HOST_CLOCK, 'now').mockReturnValue(400)
    await expect(seam.send(h.host, KEY, 'd1', { text: 'ship it' })).resolves.toEqual({
      outcome: 'accepted'
    })
    clock.mockRestore()
    await eventually(() => expect(hostTestState().dispatch).toHaveBeenCalled())
    startTurnAt({ hookRows, paneChange }, 500)
    await finishTurn('Shipped.')

    await eventually(() =>
      expect(events.slice(1)).toEqual([
        // The turn answers the one delivery that started it.
        {
          kind: 'turn-started',
          conversation: KEY,
          worktreeId: WORKTREE,
          paneKey: PANE,
          at: 500,
          deliveryId: 'd1'
        },
        expect.objectContaining({
          kind: 'turn-ended',
          conversation: KEY,
          paneKey: PANE,
          turnId: 500,
          stopReason: 'success',
          lastAssistantMessage: 'Shipped.',
          origin: 'delivery'
        })
      ])
    )
  })

  it('keeps one turn, and its delivery, when its row re-dates it from the send to the handover', async () => {
    const { host } = hostTestState()
    await attach()
    const { seam, events, hookRows, paneChange, ...h } = linkedSeam(installedChats(host).chats)
    const workingSince = (at: number) => {
      hookRows.set(PANE, { ...chatRow(), receivedAt: at, stateStartedAt: at })
      paneChange({
        kind: 'observed',
        paneKey: PANE,
        workspace: { worktreeId: WORKTREE, sshHostId: null },
        phase: 'working',
        at
      })
    }
    const starts = () => events.filter((event) => event.kind === 'turn-started')
    // The live sequence: admitted just before the send is recorded at 543182, handed over at 543886.
    const clock = vi.spyOn(HOST_CLOCK, 'now').mockReturnValue(1_793_527_543_181)
    await seam.send(h.host, KEY, 'd1', { text: 'search Slack for export' })
    clock.mockRestore()
    workingSince(1_793_527_543_182)
    workingSince(1_793_527_543_886)
    expect(starts()).toEqual([expect.objectContaining({ at: 1_793_527_543_182, deliveryId: 'd1' })])
    // What a connector call in this turn carries: the turn the grant is bound to.
    expect(seam.replyTarget(PANE)?.turnId).toBe(1_793_527_543_182)
    await finishTurn('Searched.')
    await eventually(() => expect(ended(events)).toHaveLength(1))
    expect(ended(events)[0]).toMatchObject({ turnId: 1_793_527_543_182 })
    // A real next turn, after that end, is a new turn.
    await seam.send(h.host, KEY, 'd2', { text: 'and the docs' })
    workingSince(1_793_527_569_272)
    expect(starts()).toEqual([
      expect.objectContaining({ at: 1_793_527_543_182, deliveryId: 'd1' }),
      expect.objectContaining({ at: 1_793_527_569_272 })
    ])
  })

  it('keeps a turn an overlapping replacement watch adopted when its row re-dates it', async () => {
    const { host } = hostTestState()
    await attach()
    const linked = linkedSeam(installedChats(host).chats)
    const { seam, hookRows, paneChange, release, ...h } = linked
    await fromThread(linked)
    const working = (at: number) => {
      hookRows.set(PANE, { ...chatRow(), receivedAt: at, stateStartedAt: at })
      paneChange({
        kind: 'observed',
        paneKey: PANE,
        workspace: { worktreeId: WORKTREE, sshHostId: null },
        phase: 'working',
        at
      })
    }
    working(500)
    const again: (ConversationEvent | ConversationSnapshot)[] = []
    seam.watch(h.host, (event) => again.push(event))
    release()
    working(520)
    expect(again[0]).toMatchObject({ kind: 'snapshot', conversations: [{ turnId: 500 }] })
    expect(again.filter((event) => event.kind === 'turn-started')).toEqual([])
    expect(seam.replyTarget(PANE)?.turnId).toBe(500)
  })

  it('names no delivery for a turn two deliveries were waiting to start', async () => {
    const { host } = hostTestState()
    await attach()
    const { seam, events, hookRows, paneChange, ...h } = linkedSeam(installedChats(host).chats)
    const clock = vi.spyOn(HOST_CLOCK, 'now').mockReturnValue(400)
    await seam.send(h.host, KEY, 'd1', { text: 'ship it' })
    await seam.send(h.host, KEY, 'd2', { text: 'and the docs' })
    clock.mockRestore()
    startTurnAt({ hookRows, paneChange }, 500)
    await eventually(() => expect(events.some((event) => event.kind === 'turn-started')).toBe(true))
    expect(events.find((event) => event.kind === 'turn-started')).not.toHaveProperty('deliveryId')
  })

  it("names no delivery for a turn whose start is seen before the last turn's end", async () => {
    const { host } = hostTestState()
    await attach()
    const { seam, events, hookRows, paneChange, ...h } = linkedSeam(installedChats(host).chats)
    const startAt = (at: number) => startTurnAt({ hookRows, paneChange }, at)
    const clock = vi.spyOn(HOST_CLOCK, 'now').mockReturnValue(400)
    await seam.send(h.host, KEY, 'd1', { text: 'ship it' })
    startAt(500)
    // A message during that turn; the next turn's row arrives before its end does.
    clock.mockReturnValue(700)
    await seam.send(h.host, KEY, 'd2', { text: 'and the docs' })
    clock.mockRestore()
    startAt(900)
    await eventually(() =>
      expect(events.filter((event) => event.kind === 'turn-started')).toHaveLength(2)
    )
    const [first, second] = events.filter((event) => event.kind === 'turn-started')
    expect(first).toMatchObject({ deliveryId: 'd1' })
    expect(second).not.toHaveProperty('deliveryId')
  })

  describe("a turn a worker's report started", () => {
    // A report inherits where the turn that started its worker came from.
    it('tells a bot’s thread of it only when a turn the thread asked for started the worker', async () => {
      const { host } = hostTestState()
      await attach()
      const linked = linkedSeam(installedChats(host).chats, THREAD_BOT)
      const { events, hookRows, paneChange, seam } = linked
      const asked = () => seam.conversationTurn(linked.host.chat, HOST_TEST_SESSION)
      let completions = 0
      const count = (event: { type: string }) => void (event.type === 'completion' && completions++)
      host.subscribeTurnCompletions({ id: 'test-completions', emit: count })

      await finishTurn('The typed-in worker shipped it.', {
        opener: workerReport(false),
        running: () => {
          startTurnAt({ hookRows, paneChange }, 500)
          expect(asked()).toBe(false)
        }
      })
      // The first turn's end closes it before the next one starts; under load it trails the write.
      await vi.waitFor(() => expect(completions).toBe(1), { timeout: 5_000 })
      await finishTurn('The worker shipped it.', {
        opener: MAIL_NOTICE,
        turnId: 'turn-2',
        running: async () => {
          // The status row moves with the publish that carries the turn's opener.
          await eventually(() => expect(asked()).toBe(true))
          startTurnAt({ hookRows, paneChange }, 900)
          // A new watch (connectors off and on) still knows the turn is the thread's, from its journal.
          linked.release()
          seam.watch(linked.host, (event) => events.push(event))
          expect(asked()).toBe(true)
        }
      })

      await eventually(() => expect(ended(events)).toHaveLength(1))
      // From the report's turn on: the first turn's own events land in any order under load.
      const from = events.findIndex((event) => event.kind === 'turn-started' && event.at === 900)
      expect(events.slice(from)).toEqual([
        expect.objectContaining({ kind: 'turn-started', at: 900 }),
        expect.objectContaining({ conversations: [expect.objectContaining({ working: true })] }),
        expect.objectContaining({
          turnId: 900,
          origin: 'delivery',
          lastAssistantMessage: 'The worker shipped it.'
        })
      ])
    })

    it('names the pull request its work opened on a Linear thread, which shows it', async () => {
      const { host } = hostTestState()
      await attach()
      const link = { url: 'https://github.com/org/repo/pull/7', title: 'Pull request #7' }
      const bots = { refusal: () => null, open: vi.fn(), workLinks: vi.fn(async () => [link]) }
      const linear: ConversationKey = { source: 'linear', externalId: 'org-1:session-1' }
      const { events } = linkedSeam(installedChats(host).chats, THREAD_BOT, undefined, bots, linear)

      await finishTurn('The worker opened a PR.', { opener: MAIL_NOTICE })

      await eventually(() =>
        expect(ended(events)).toEqual([expect.objectContaining({ links: [link] })])
      )
    })

    it('never looks up links for a source that shows none', async () => {
      const { host } = hostTestState()
      await attach()
      const bots = { refusal: () => null, open: vi.fn(), workLinks: vi.fn(async () => []) }
      const { events } = linkedSeam(installedChats(host).chats, THREAD_BOT, undefined, bots)

      await finishTurn('Done.', { opener: MAIL_NOTICE })

      await eventually(() => expect(ended(events)).toHaveLength(1))
      expect(ended(events)[0]).not.toHaveProperty('links')
      expect(bots.workLinks).not.toHaveBeenCalled()
    })

    // The owner's Chat turns, typed or woken in Orca, never reach the direct message it shares.
    it("stays in Orca for a bot's Chat, which is also its owner's", async () => {
      const { host } = hostTestState()
      await attach()
      const shared = linkedSeam(installedChats(host).chats, { kind: 'bot-chat', botId: 'b1' })
      const thread = linkedSeam(installedChats(host).chats, THREAD_BOT)

      await finishTurn('The worker shipped it.', { opener: MAIL_NOTICE })

      // The same turn reaches a thread's chat, so it has ended by now.
      await eventually(() => expect(ended(thread.events)).toHaveLength(1))
      expect(ended(shared.events)).toEqual([])
    })

    it('posts a turn typed in Orca to the thread whose message joined it, and to no other', async () => {
      const { host } = hostTestState()
      await attach()
      const { events } = linkedSeam(installedChats(host).chats, THREAD_BOT)
      const asked = linkedSeam(
        installedChats(host).chats,
        THREAD_BOT,
        undefined,
        undefined,
        KEY,
        true
      )
      await fromThread(asked)

      await finishTurn('Done locally.', { opener: 'person', steer: MAIL_NOTICE })

      await eventually(() => expect(ended(asked.events)).toHaveLength(1))
      expect(ended(asked.events)[0]).toMatchObject({
        origin: 'delivery',
        lastAssistantMessage: 'Done locally.'
      })
      expect(ended(events)).toEqual([])
    })
  })

  describe('a bot whose workers outlive its turn', () => {
    it('tells the workers running before the turn ends, so the end never reads done', async () => {
      const { host } = hostTestState()
      await attach()
      let state: 'working' | 'completed' = 'completed'
      const read = vi.fn(async () => [{ state }])
      const { events, ...linked } = linkedSeam(installedChats(host).chats, THREAD_BOT, { read })
      // The watch's first read says none run, in case an earlier process said they did.
      await eventually(() =>
        expect(events.filter((event) => event.kind === 'workers')).toEqual([
          {
            kind: 'workers',
            conversation: KEY,
            worktreeId: WORKTREE,
            paneKey: PANE,
            running: false
          }
        ])
      )
      expect(read).toHaveBeenCalledWith(HOST_TEST_SESSION)

      state = 'working'
      await fromThread(linked)
      await finishTurn('Handed it to a worker.')

      await eventually(() => expect(ended(events)).toHaveLength(1))
      expect(events.slice(-2)).toEqual([
        expect.objectContaining({ kind: 'workers', paneKey: PANE, running: true }),
        expect.objectContaining({
          kind: 'turn-ended',
          lastAssistantMessage: 'Handed it to a worker.'
        })
      ])
    })

    it('tells nothing for a chat host that reads no workers', async () => {
      const { host } = hostTestState()
      await attach()
      const { events, ...linked } = linkedSeam(installedChats(host).chats, {
        kind: 'bot',
        botId: 'b1'
      })
      await fromThread(linked)

      await finishTurn('Done.')

      await eventually(() => expect(ended(events)).toHaveLength(1))
      expect(events.some((event) => event.kind === 'workers')).toBe(false)
    })
  })

  it('tells an approval the chat raises, answerable by its option ids', async () => {
    const { host } = hostTestState()
    await attach()
    const { seam, events, ...h } = linkedSeam(installedChats(host).chats)
    await seam.send(h.host, KEY, 'd1', { text: 'run it' })

    const { itemId } = await seedApproval('allow')

    // The prompt rides the next status publish, which trails the row under load.
    await vi.waitFor(
      () =>
        expect(events.at(-1)).toEqual({
          kind: 'prompt',
          conversation: KEY,
          worktreeId: WORKTREE,
          paneKey: PANE,
          prompt: {
            kind: 'approval',
            promptId: itemId,
            tool: 'Run the command?',
            options: [{ id: 'allow', label: 'Allow' }]
          }
        }),
      { timeout: 5_000 }
    )
    await expect(seam.answer(h.host, KEY, itemId, 'allow')).resolves.toEqual({
      outcome: 'accepted'
    })
  })

  it('refuses an answer for a paused bot, but still takes its Stop', async () => {
    const { host, cancelTurn } = hostTestState()
    await attach()
    const { seam, ...h } = linkedSeam(installedChats(host).chats)
    seam.linkChat(BOT_KEY, {
      worktreeId: WORKTREE,
      sessionId: HOST_TEST_SESSION,
      agent: 'codex',
      bot: THREAD_BOT
    })
    const paused = {
      ...h.host,
      bots: { refusal: () => 'bot_paused' as const, open: vi.fn(), workLinks: async () => [] }
    }
    const { itemId } = await seedApproval()
    await agentReady(host, HOST_TEST_SESSION)

    await expect(seam.answer(paused, BOT_KEY, itemId, 'allow')).resolves.toEqual(
      refused('bot_paused')
    )
    // Pausing stops new work; it never keeps running work from being stopped.
    await expect(seam.cancel(paused, BOT_KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  it('tells an approval answered in Orca once the lead works past it, and only once', async () => {
    const { host } = hostTestState()
    await attach()
    const { seam, events, hookRows, paneChange, ...h } = linkedSeam(installedChats(host).chats)
    await seam.send(h.host, KEY, 'd1', { text: 'run it' })
    const { itemId } = await seedApproval('allow')
    // The connector reads the prompt as of the chat's status publish.
    await eventually(() =>
      expect(host.publishedWork(HOST_TEST_SESSION)?.actionablePrompts).toHaveLength(1)
    )
    const observe = (state: 'blocked' | 'working'): void => {
      hookRows.set(PANE, { ...chatRow(), mainAgent: { state, stateStartedAt: 600 } })
      paneChange({
        kind: 'observed',
        paneKey: PANE,
        workspace: { worktreeId: WORKTREE, sshHostId: null },
        phase: state === 'working' ? 'working' : 'needs-you',
        at: 0
      })
    }

    observe('blocked')
    expect(events.filter((event) => event.kind === 'prompt' && event.answered)).toEqual([])
    observe('working')
    observe('working')

    expect(events.filter((event) => event.kind === 'prompt' && event.answered)).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        prompt: expect.objectContaining({ promptId: itemId })
      })
    ])
  })

  it('names a chat turn one way in its start, snapshot, replies, and end, whatever its row’s hook stamp', async () => {
    const { host } = hostTestState()
    await attach()
    const h = harness()
    // The agent's own hook stamps its turn later than the chat started working.
    h.hookRows.set(PANE, { ...chatRow(), turnStartedAt: 635 })
    h.seam.linkChat(KEY, { worktreeId: WORKTREE, sessionId: HOST_TEST_SESSION, agent: 'codex' })
    const chats = installedChats(host).chats
    await h.seam.send({ chat: chats }, KEY, 'from-thread', { text: 'go' })
    const events: (ConversationEvent | ConversationSnapshot)[] = []
    h.seam.watch({ chat: chats }, (event) => events.push(event))

    // A newer id in the snapshot would leave the cloud's turn open past an end named 500.
    expect(events[0]).toMatchObject({ conversations: [{ turnId: 500, working: true }] })
    expect(h.seam.replyTarget(PANE)).toMatchObject({ key: KEY, turnId: 500 })
    await finishTurn('Finished.')
    await eventually(() =>
      expect(ended(events)).toEqual([expect.objectContaining({ turnId: 500 })])
    )
  })

  it('names a turn already running when the watch began by its row, for replies and its end', async () => {
    const { host } = hostTestState()
    await attach()
    const h = harness()
    h.hookRows.set(PANE, chatRow())
    h.seam.linkChat(KEY, { worktreeId: WORKTREE, sessionId: HOST_TEST_SESSION, agent: 'codex' })
    const chats = installedChats(host).chats
    await h.seam.send({ chat: chats }, KEY, 'from-thread', { text: 'go' })
    const events: (ConversationEvent | ConversationSnapshot)[] = []
    h.seam.watch({ chat: chats }, (event) => events.push(event))

    expect(events[0]).toMatchObject({ conversations: [{ turnId: 500, working: true }] })
    expect(h.seam.replyTarget(PANE)).toMatchObject({ key: KEY, turnId: 500 })
    await finishTurn('Finished.')
    await eventually(() =>
      expect(ended(events)).toEqual([expect.objectContaining({ turnId: 500 })])
    )
  })

  it('posts the whole last message, not the status row’s short preview', async () => {
    const { host } = hostTestState()
    await attach()
    const { events, ...linked } = linkedSeam(installedChats(host).chats)
    const long = `${'Line one of a long answer. '.repeat(20)}\n\nSecond paragraph.`

    await fromThread(linked)
    await finishTurn(long)

    await eventually(() =>
      expect(ended(events)).toEqual([expect.objectContaining({ lastAssistantMessage: long })])
    )
  })

  it('posts nothing for a bot’s quiet turn', async () => {
    const { host } = hostTestState()
    await attach()
    const linked = linkedSeam(installedChats(host).chats)
    const { events, seam } = linked
    seam.linkChat(BOT_KEY, {
      worktreeId: WORKTREE,
      sessionId: HOST_TEST_SESSION,
      agent: 'codex',
      bot: THREAD_BOT
    })
    await fromThread(linked, BOT_KEY)
    await finishTurn('Nothing new. NO_REPLY')

    await eventually(() => expect(ended(events)).toHaveLength(1))
    expect(ended(events)[0]).not.toHaveProperty('lastAssistantMessage')
  })

  it('posts nothing for a PR wake the bot answers quietly, sent as the connector’s with its source', async () => {
    const { host, dispatch } = hostTestState()
    await attach()
    const { seam, events, ...h } = linkedSeam(installedChats(host).chats)
    const chat = {
      worktreeId: WORKTREE,
      sessionId: HOST_TEST_SESSION,
      agent: 'codex' as const,
      bot: { kind: 'bot' as const, botId: 'b1' }
    }
    seam.linkChat(BOT_KEY, chat)
    const bots = {
      refusal: () => null,
      open: vi.fn<ConversationBots['open']>(async () => chat),
      workLinks: async () => []
    }

    await expect(
      seam.send({ ...h.host, bots }, BOT_KEY, 'pr-wake:500#8:abc:ci', {
        text: 'GitHub: Checks failing on acme/web#8.',
        note: `If it is superseded, end your reply with ${BOT_QUIET_MARKER}.`,
        memorySource: 'GitHub acme/web#8'
      })
    ).resolves.toEqual({ outcome: 'accepted' })
    await eventually(() => expect(dispatch).toHaveBeenCalled())
    // No one asked, yet the turn is the connector's, so it finds its conversation and memory its source.
    expect(JSON.stringify(dispatch.mock.calls.at(-1))).toContain('"origin":"connector"')
    expect(JSON.stringify(dispatch.mock.calls.at(-1))).toContain(
      '"memorySource":"GitHub acme/web#8"'
    )
    await finishTurn(`The pull request moved past that commit. ${BOT_QUIET_MARKER}`)

    await eventually(() => expect(ended(events)).toHaveLength(1))
    expect(ended(events)[0]).not.toHaveProperty('lastAssistantMessage')
  })

  it('ends a turn that failed with why, typed, and no words of its own', async () => {
    const { host } = hostTestState()
    await attach()
    const { events, ...linked } = linkedSeam(installedChats(host).chats)

    await fromThread(linked)
    await failTurn()

    await eventually(() => expect(ended(events)).toHaveLength(1))
    expect(ended(events)[0]).toMatchObject({
      stopReason: 'failure',
      failure: {
        category: 'usage_limit',
        agentName: 'Codex',
        usageLimit: { window: 'weekly', resetsAt: 1_900_000_000_000 },
        timeZone: expect.any(String)
      }
    })
    expect(ended(events)[0]).not.toHaveProperty('lastAssistantMessage')
  })

  it('ends a turn that succeeded with no failure', async () => {
    const { host } = hostTestState()
    await attach()
    const { events, ...linked } = linkedSeam(installedChats(host).chats)

    await fromThread(linked)
    await finishTurn('All good.')

    await eventually(() => expect(ended(events)).toHaveLength(1))
    expect(ended(events)[0]).not.toHaveProperty('failure')
  })

  it('keeps a quiet marker as text in a chat that is not a bot’s', async () => {
    const { host } = hostTestState()
    await attach()
    const { events, ...linked } = linkedSeam(installedChats(host).chats)

    await fromThread(linked)
    await finishTurn('NO_REPLY')

    await eventually(() =>
      expect(ended(events)).toEqual([expect.objectContaining({ lastAssistantMessage: 'NO_REPLY' })])
    )
  })

  it('starts a new turn when the lead starts working while background work keeps the row working', async () => {
    const { host } = hostTestState()
    await attach()
    const { events, hookRows, paneChange, ...linked } = linkedSeam(installedChats(host).chats)
    await fromThread(linked)
    const observe = (mainAgent: AgentStatusIpcPayload['mainAgent']): void => {
      hookRows.set(PANE, { ...chatRow(), mainAgent })
      paneChange({
        kind: 'observed',
        paneKey: PANE,
        workspace: { worktreeId: WORKTREE, sshHostId: null },
        phase: 'working',
        at: 0
      })
    }

    observe({ state: 'working', stateStartedAt: 600 })
    observe({ state: 'blocked', stateStartedAt: 650 })
    observe({ state: 'working', stateStartedAt: 660 })
    observe({ state: 'done', stateStartedAt: 700 })
    observe({ state: 'working', stateStartedAt: 800 })

    expect(events.filter((event) => event.kind === 'turn-started')).toEqual([
      expect.objectContaining({ at: 600 }),
      expect.objectContaining({ at: 800 })
    ])
  })

  it('refuses to link a conversation already linked elsewhere, and repeats an identical link', async () => {
    const { host } = hostTestState()
    await attach()
    const { seam } = linkedSeam(installedChats(host).chats)
    const chat = { worktreeId: WORKTREE, sessionId: HOST_TEST_SESSION, agent: 'codex' as const }

    expect(() => seam.linkChat(KEY, chat)).not.toThrow()
    expect(() => seam.linkChat(KEY, { ...chat, sessionId: 'other-session' })).toThrow(
      'external_conversation_already_linked'
    )
    expect(() => seam.linkChat({ ...KEY, externalId: 'T1:C9:2:U5' }, chat)).toThrow(
      'external_conversation_already_linked'
    )
  })

  it('snapshots a chat whose lead is done as not working, though background work runs', async () => {
    const { host } = hostTestState()
    await attach()
    const h = harness()
    h.hookRows.set(PANE, { ...chatRow(), mainAgent: { state: 'done', stateStartedAt: 700 } })
    h.seam.linkChat(KEY, { worktreeId: WORKTREE, sessionId: HOST_TEST_SESSION, agent: 'codex' })
    const events: (ConversationEvent | ConversationSnapshot)[] = []
    h.seam.watch(
      {
        chat: installedChats(host).chats
      },
      (event) => events.push(event)
    )

    expect(events[0]).toMatchObject({ conversations: [{ working: false, turnId: null }] })
  })

  it('follows a host installed after the watch began', async () => {
    const { host } = hostTestState()
    await attach()
    const slot = installedChats(null)
    const { events, ...linked } = linkedSeam(slot.chats)

    slot.install(host)
    await fromThread(linked)
    await finishTurn('Later.')

    await eventually(() => expect(ended(events)).toHaveLength(1))
  })

  it('resolves a reply by the chat’s pane key while watched', async () => {
    const { host } = hostTestState()
    await attach()
    const { seam } = linkedSeam(installedChats(host).chats)

    expect(seam.replyTarget(PANE)).toMatchObject({ key: KEY, turnId: null })
  })

  it('stops the chat’s turn through its own Stop', async () => {
    const { host, cancelTurn } = hostTestState()
    await attach()
    const { seam, ...h } = linkedSeam(installedChats(host).chats)
    await seedApproval()
    await agentReady(host, HOST_TEST_SESSION)

    await expect(seam.cancel(h.host, KEY, 'c1')).resolves.toEqual({ outcome: 'accepted' })
    expect(cancelTurn).toHaveBeenCalledOnce()
  })

  it('takes a Stop bound to the running turn, and refuses one bound to any other', async () => {
    const { host, cancelTurn } = hostTestState()
    await attach()
    const { seam, hookRows, paneChange, ...h } = linkedSeam(installedChats(host).chats)
    await seedApproval()
    hookRows.set(PANE, chatRow())
    paneChange({
      kind: 'observed',
      paneKey: PANE,
      workspace: { worktreeId: WORKTREE, sshHostId: null },
      phase: 'working',
      at: 500
    })

    await expect(seam.cancel(h.host, KEY, 'stale', 499)).resolves.toEqual({
      outcome: 'refused',
      reason: 'turn_not_running'
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    await expect(seam.cancel(h.host, KEY, 'current', 500)).resolves.toEqual({
      outcome: 'accepted'
    })
    expect(cancelTurn).toHaveBeenCalledOnce()
  })
})

describe('a mail prompt on a linked bot chat', () => {
  it.each(['bot', 'bot-chat'] as const)(
    'restates a %s adopted turn after reconnect, even after the answer',
    async (kind) => {
      const { host } = hostTestState()
      await attach()
      const h = linkedSeam(
        installedChats(host).chats,
        { kind, botId: 'b1' },
        undefined,
        undefined,
        KEY,
        true
      )
      await finishTurn('Private mail result', {
        opener: workerReport(false),
        running: async () => {
          startTurnAt(h, 500)
          const { itemId } = await seedApproval('allow')
          await eventually(() =>
            expect(h.events.at(-1)).toMatchObject({
              kind: 'prompt',
              prompt: { raisedBy: 'orca', promptId: itemId, wokenBy: 'Worker' }
            })
          )
          expect(h.events.filter((event) => event.kind === 'turn-started')).toEqual([
            expect.objectContaining({ at: 500 })
          ])
          h.release()
          let release = h.seam.watch(h.host, (event) => h.events.push(event))
          expect(h.events.at(-1)).toMatchObject({
            kind: 'snapshot',
            conversations: [
              { working: true, turnId: 500, prompt: { promptId: itemId, raisedBy: 'orca' } }
            ]
          })
          await h.seam.answer(
            { ...h.host, bots: { refusal: () => null, open: vi.fn(), workLinks: async () => [] } },
            KEY,
            itemId,
            'allow'
          )
          await eventually(() =>
            expect(host.publishedWork(HOST_TEST_SESSION)?.actionablePrompts).toEqual([])
          )
          release()
          release = h.seam.watch(h.host, (event) => h.events.push(event))
          expect(h.events.at(-1)).toMatchObject({
            kind: 'snapshot',
            conversations: [{ working: true, turnId: 500, prompt: null }]
          })
        }
      })
      await eventually(() => expect(ended(h.events)).toHaveLength(1))
      expect(ended(h.events)[0]).toMatchObject({ origin: 'local', turnId: 500 })
      expect(ended(h.events)[0]).not.toHaveProperty('lastAssistantMessage')
      expect(ended(h.events)[0]).not.toHaveProperty('links')
    }
  )
})
