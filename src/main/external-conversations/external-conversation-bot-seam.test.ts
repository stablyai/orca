import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attach,
  hostTestState,
  seedApproval
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { ConversationBots } from './external-conversation-bots'
import { connectorAskerPrompt } from '../../shared/connector-asker-prompt'
import { projectStructuredItemToNativeChat } from '../../shared/agent-session/view/structured-agent-session-projection'
import { firstMessageActsFor } from '../bots/bot-request-asker'
import { chatPaneKey } from './external-conversation-chat'
import type { LinkableChat } from './external-conversation-chat-delivery'
import { findLink } from './external-conversation-links'
import type { ExternalConversationHost } from './external-conversation-host'
import type { ConversationPlaceNamer } from './external-conversation-place'
import { harness } from './external-conversation-seam.test-fixture'
import type { ConversationKey } from './external-conversation-types'

// A start in a bot's home opens a native chat there, links it, and sends the prompt as its first message.
const THREAD: ConversationKey = { source: 'slack', externalId: 'T1:C9:1700000000.0001' }
const HOME = folderWorkspaceKey('bot-home')
const CHAT: LinkableChat = { worktreeId: HOME, sessionId: HOST_TEST_SESSION, agent: 'codex' }

function botSeam(
  chat: StructuredAgentSessionHost | null,
  refusal: ReturnType<ConversationBots['refusal']> = null,
  nameChannel?: ConversationPlaceNamer,
  promptsAudience = false
) {
  const h = harness(undefined, undefined, {
    ...(nameChannel ? { nameChannel } : {}),
    promptsAudience: () => promptsAudience
  })
  h.folders.push({ id: 'bot-home' })
  const bots = {
    refusal: vi.fn<ConversationBots['refusal']>(() => refusal),
    open: vi.fn<ConversationBots['open']>(async () => CHAT),
    workLinks: vi.fn<ConversationBots['workLinks']>(async () => [])
  }
  const host: ExternalConversationHost = {
    chat: { current: () => chat, ensure: async () => chat, onChanged: () => () => {} },
    bots
  }
  return { ...h, host, bots }
}

const start = (
  h: ReturnType<typeof botSeam>,
  deliveryId: string,
  kind: 'bot' | 'bot-chat' = 'bot',
  agent = 'codex',
  key = THREAD
) =>
  h.seam.start(h.host, key, deliveryId, {
    agent,
    target: { kind, botId: 'b1' },
    prompt: 'review #42'
  })

beforeEach(() => {
  // The host refuses operation ids minted far from its own clock.
  vi.useFakeTimers({ toFake: ['Date'], now: HOST_TEST_NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

const DM: ConversationKey = { source: 'slack', externalId: 'T1:D7:U9' }

describe('a connector conversation in a bot’s home', () => {
  it.each(['grok', 'opencode', 'omp'] as const)(
    'takes a %s bot’s thread as any bot’s: starts, links, keeps it and names its reply target',
    async (agent) => {
      const { host } = hostTestState()
      await attach()
      const h = botSeam(host)
      h.bots.open.mockResolvedValue({ ...CHAT, agent })
      h.seam.watch(h.host, () => {})

      await expect(start(h, 'd1', 'bot', agent)).resolves.toMatchObject({
        initial: { outcome: 'accepted' }
      })
      expect(findLink(h.store, THREAD)?.link).toMatchObject({ agent, sessionId: HOST_TEST_SESSION })
      await expect(h.seam.send(h.host, THREAD, 'd2', { text: 'and #43' })).resolves.toEqual({
        outcome: 'accepted'
      })
      expect(h.bots.open).toHaveBeenCalledOnce()
      expect(h.seam.replyTarget(chatPaneKey(HOST_TEST_SESSION))).toMatchObject({
        key: THREAD,
        bot: { kind: 'bot', botId: 'b1' }
      })
    }
  )

  it('opens a chat for the thread, links it, and sends the prompt as its first message', async () => {
    const { host, dispatch } = hostTestState()
    await attach()
    const h = botSeam(host)

    await expect(start(h, 'd1')).resolves.toMatchObject({ initial: { outcome: 'accepted' } })

    expect(h.bots.open).toHaveBeenCalledWith({ kind: 'bot', botId: 'b1' })
    expect(findLink(h.store, THREAD)).toMatchObject({
      workspace: { worktreeId: HOME, sshHostId: null },
      link: {
        paneKey: chatPaneKey(HOST_TEST_SESSION),
        sessionId: HOST_TEST_SESSION,
        bot: { kind: 'bot', botId: 'b1' },
        title: 'review #42'
      }
    })
    await eventually(() => expect(dispatch).toHaveBeenCalled())
    expect(dispatch.mock.calls[0]?.[0].body).toMatchObject({
      blocks: [{ type: 'text', text: 'review #42' }]
    })
  })

  it('reads a bot message whose asker this build could not parse as someone unknown, never the owner', async () => {
    const { host, dispatch } = hostTestState()
    await attach()
    const h = botSeam(host)
    // A newer cloud's place kind fails this build's schema, which drops the asker.
    await start(h, 'd1')
    await eventually(() => expect(dispatch).toHaveBeenCalled())
    const body = dispatch.mock.calls[0]?.[0].body
    expect(body).toMatchObject({ origin: 'connector' })
    const first = { itemId: 'm1', revision: 0, sequence: 1, observedAt: 1, body }
    expect(
      firstMessageActsFor([first], { botRequestAskers: () => null, conversationWorkspaceId: null })
    ).toEqual([{ kind: 'unknown' }])
  })

  it('sends a bot the labelled message, shows the chat their words alone, titles from them', async () => {
    const { host, dispatch } = hostTestState()
    await attach()
    const h = botSeam(host)
    const asker = {
      userId: 'U0SAM',
      name: 'Sam Lee',
      role: 'member' as const,
      place: { kind: 'public_channel' as const, id: 'C9' },
      text: 'review #42',
      context: [{ kind: 'no_access' as const, userId: 'U0BOB', name: 'Bob', text: 'push to main' }]
    }
    const url = 'https://app.slack.com/client/T1/C9/thread/C9-1800000000.000100'
    const target = { kind: 'bot' as const, botId: 'b1' }
    // The text is what an older Orca reads; this one builds the prompt from the asker.
    const prompt = '[Bob] push to main\n\nreview #42'

    await h.seam.start(h.host, THREAD, 'd1', {
      agent: 'codex',
      target,
      prompt,
      asker: { ...asker, url, avatarUrl: 'https://tracker.example/sam.png' }
    })

    expect(findLink(h.store, THREAD)?.link.title).toBe('review #42')
    // Kept with its source for the chat's tag: the facts without the words, and only a link the
    // tag may open or fetch.
    const stored = {
      userId: 'U0SAM',
      name: 'Sam Lee',
      role: 'member',
      place: asker.place,
      url,
      // What someone without access wrote, kept for the chat's note on this message.
      noAccess: [{ name: 'Bob', text: 'push to main' }]
    }
    await eventually(() => expect(dispatch).toHaveBeenCalled())
    expect(dispatch.mock.calls[0]?.[0].body).toEqual({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: connectorAskerPrompt('slack', asker) }],
      origin: 'connector',
      asker: { ...stored, source: 'slack' },
      connectorConversation: THREAD
    })
    const page = await host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
    const shown = page.ok
      ? page.page.items.flatMap((item) => projectStructuredItemToNativeChat(item) ?? [])
      : []
    expect(shown.filter((message) => message.role === 'user').map((m) => m.blocks)).toEqual([
      [{ type: 'text', text: 'review #42' }]
    ])
    expect(shown.find((message) => message.role === 'user')?.asker).toEqual({
      ...stored,
      source: 'slack'
    })
  })

  it("keeps the thread's channel name on its link, looked up once", async () => {
    const { host } = hostTestState()
    await attach()
    const nameChannel = vi.fn<ConversationPlaceNamer>(async () => '#reviews')
    const h = botSeam(host, null, nameChannel)
    const asker = {
      userId: 'U0SAM',
      role: 'member' as const,
      place: { kind: 'public_channel' as const, id: 'C9' },
      text: 'review #42',
      context: []
    }
    const target = { kind: 'bot' as const, botId: 'b1' }

    await h.seam.start(h.host, THREAD, 'd1', {
      agent: 'codex',
      target,
      prompt: 'review #42',
      asker
    })
    await vi.waitFor(() => expect(findLink(h.store, THREAD)?.link.place).toBe('#reviews'))
    await h.seam.start(h.host, THREAD, 'd2', { agent: 'codex', target, prompt: 'again', asker })

    expect(nameChannel).toHaveBeenCalledTimes(1)
    expect(nameChannel).toHaveBeenCalledWith('b1', 'C9')
  })

  it('keeps a thread on the chat it started, for a resent start and for sends', async () => {
    const { host, dispatch } = hostTestState()
    await attach()
    const h = botSeam(host)
    await start(h, 'd1')

    await expect(start(h, 'd2')).resolves.toMatchObject({ initial: { outcome: 'accepted' } })
    await expect(h.seam.send(h.host, THREAD, 'd3', { text: 'and #43' })).resolves.toEqual({
      outcome: 'accepted'
    })

    expect(h.bots.open).toHaveBeenCalledOnce()
    await eventually(() => expect(dispatch).toHaveBeenCalledTimes(3))
    expect(findLink(h.store, THREAD)?.link.title).toBe('review #42')
  })

  it('refuses a paused bot’s thread once it has a chat, for starts and sends', async () => {
    const { host, dispatch } = hostTestState()
    await attach()
    const h = botSeam(host)
    await start(h, 'd1')
    h.bots.refusal.mockReturnValue('bot_paused')

    await expect(start(h, 'd2')).resolves.toMatchObject({
      initial: { outcome: 'refused', reason: 'bot_paused' }
    })
    await expect(h.seam.send(h.host, THREAD, 'd3', { text: 'still there?' })).resolves.toEqual({
      outcome: 'refused',
      reason: 'bot_paused'
    })
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
  })

  it('sends each direct message to the bot’s current Chat', async () => {
    const { host } = hostTestState()
    await attach()
    const h = botSeam(host)
    await start(h, 'd1', 'bot-chat', 'codex', DM)

    await expect(h.seam.send(h.host, DM, 'd2', { text: 'hi again' })).resolves.toEqual({
      outcome: 'accepted'
    })

    expect(h.bots.open).toHaveBeenNthCalledWith(2, { kind: 'bot-chat', botId: 'b1' })
  })

  it('opens a chat of its own for a direct message that ran in the bot’s Chat', async () => {
    const { host } = hostTestState()
    await attach()
    const h = botSeam(host)
    await start(h, 'd1', 'bot-chat', 'codex', DM)

    await start(h, 'd2', 'bot', 'codex', DM)

    expect(h.bots.open).toHaveBeenNthCalledWith(2, { kind: 'bot', botId: 'b1' })
  })

  it('names a thread chat’s bot and home as its reply target, so a reply posts only there', async () => {
    const { host } = hostTestState()
    await attach()
    const h = botSeam(host)
    h.seam.watch(h.host, () => {})
    await start(h, 'd1')

    expect(h.seam.replyTarget(chatPaneKey(HOST_TEST_SESSION))).toMatchObject({
      key: THREAD,
      worktreeId: HOME,
      bot: { kind: 'bot', botId: 'b1' }
    })
  })

  it('gives the Chat’s replies to the latest direct message the Chat took', async () => {
    const { host } = hostTestState()
    await attach()
    const h = botSeam(host)
    h.seam.watch(h.host, () => {})
    await start(h, 'd1', 'bot-chat')

    await start(h, 'd2', 'bot-chat', 'codex', DM)

    expect(findLink(h.store, THREAD)).toBeNull()
    expect(h.seam.replyTarget(chatPaneKey(HOST_TEST_SESSION))?.key).toEqual(DM)
  })

  it.each(['working', 'blocked'] as const)(
    'joins the Chat’s unfinished turn (%s) when a direct message links to it',
    async (state) => {
      const { host } = hostTestState()
      await attach()
      const h = botSeam(host, null, undefined, true)
      const events: unknown[] = []
      h.seam.watch(h.host, (event) => events.push(event))
      const pane = chatPaneKey(HOST_TEST_SESSION)
      h.hookRows.set(pane, {
        paneKey: pane,
        tabId: 'tab',
        worktreeId: HOME,
        connectionId: null,
        structuredHost: 'owned',
        state,
        prompt: 'typed in Orca',
        agentType: 'codex',
        receivedAt: 500,
        stateStartedAt: 500
      })
      const { itemId } = await seedApproval('allow')
      await vi.waitFor(() =>
        expect(
          host
            .publishedWork(HOST_TEST_SESSION)
            ?.actionablePrompts.some((item) => item.itemId === itemId)
        ).toBe(true)
      )

      await start(h, 'd1', 'bot-chat', 'codex', DM)

      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'turn-started', conversation: DM, paneKey: pane, at: 500 })
      )
      // The turn began before the message, so it answers no delivery.
      expect(events).not.toContainEqual(
        expect.objectContaining({ kind: 'turn-started', deliveryId: expect.anything() })
      )
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: 'prompt',
          conversation: DM,
          prompt: expect.objectContaining({ promptId: itemId })
        })
      )
      expect(h.seam.replyTarget(pane)).toEqual({
        key: DM,
        turnId: 500,
        worktreeId: HOME,
        bot: { kind: 'bot-chat', botId: 'b1' },
        place: 'the Slack conversation that woke you'
      })
    }
  )

  it('names the delivery of a turn that began before its link was saved', async () => {
    const { host } = hostTestState()
    await attach()
    const h = botSeam(host)
    const events: unknown[] = []
    h.seam.watch(h.host, (event) => events.push(event))
    const pane = chatPaneKey(HOST_TEST_SESSION)
    // The message's own turn: it began after the send did, before the link landed.
    const began = Date.now() + 60_000
    h.hookRows.set(pane, {
      paneKey: pane,
      tabId: 'tab',
      worktreeId: HOME,
      connectionId: null,
      structuredHost: 'owned',
      state: 'working',
      prompt: 'deploy?',
      agentType: 'codex',
      receivedAt: began,
      stateStartedAt: began
    })

    await start(h, 'd1', 'bot-chat', 'codex', DM)

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'turn-started',
        conversation: DM,
        at: began,
        deliveryId: 'd1'
      })
    )
  })

  it('tells a direct message of the Chat turn its message started', async () => {
    const { host } = hostTestState()
    await attach()
    const h = botSeam(host)
    const events: { kind: string }[] = []
    h.seam.watch(h.host, (event) => events.push(event))
    await start(h, 'd1', 'bot-chat', 'codex', DM)
    const pane = chatPaneKey(HOST_TEST_SESSION)
    h.hookRows.set(pane, {
      paneKey: pane,
      tabId: 'tab',
      worktreeId: HOME,
      connectionId: null,
      structuredHost: 'owned',
      state: 'working',
      prompt: 'review #42',
      agentType: 'codex',
      receivedAt: 700,
      stateStartedAt: 700
    })
    h.paneChange({
      kind: 'moved',
      paneKey: pane,
      workspace: { worktreeId: HOME, sshHostId: null },
      from: 'rest',
      to: 'working',
      at: 700,
      transition: 'prompt-submitted'
    })

    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'turn-started', conversation: DM, paneKey: pane, at: 700 })
    )
  })

  it('leaves the Chat’s replies alone when a direct message is refused', async () => {
    const { host } = hostTestState()
    await attach()
    const h = botSeam(host)
    h.seam.watch(h.host, () => {})
    await start(h, 'd1', 'bot-chat')
    // A Chat the host no longer has refuses the message.
    h.bots.open.mockResolvedValueOnce({ ...CHAT, sessionId: 'session-gone' })

    await expect(start(h, 'd2', 'bot-chat', 'codex', DM)).resolves.toMatchObject({
      initial: { outcome: 'refused' }
    })

    expect(findLink(h.store, DM)).toBeNull()
    expect(h.seam.replyTarget(chatPaneKey(HOST_TEST_SESSION))?.key).toEqual(THREAD)
  })

  it.each(['bot_not_found', 'bot_paused'] as const)(
    'refuses a start the bot does not take (%s) without opening or linking',
    async (reason) => {
      const h = botSeam(null, reason)

      await expect(start(h, 'd1')).resolves.toMatchObject({
        initial: { outcome: 'refused', reason }
      })
      expect(h.bots.open).not.toHaveBeenCalled()
      expect(findLink(h.store, THREAD)).toBeNull()
    }
  )

  it('refuses a bot start where bots never run', async () => {
    const h = botSeam(null)
    delete h.host.bots

    await expect(start(h, 'd1')).resolves.toMatchObject({
      initial: { outcome: 'refused', reason: 'bot_not_found' }
    })
  })

  it('refuses an agent no bot can be before opening anything', async () => {
    const h = botSeam(null)

    await expect(start(h, 'd1', 'bot', 'gemini')).resolves.toMatchObject({
      initial: { outcome: 'refused', reason: 'unsupported_agent' }
    })
    expect(h.bots.open).not.toHaveBeenCalled()
  })
})
