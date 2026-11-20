import { mailStartedBot } from './external-conversation-prompt-turns.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { chatPaneKey } from './external-conversation-chat'
import { ChatTurns } from './external-conversation-chat-turns'
import type { ConversationEvent } from './external-conversation-events'

const SESSION = 'session-1'

function linearThread(workLinks: () => Promise<ConnectorWorkLink[]>) {
  const link: ExternalConversationLink = {
    source: 'linear',
    externalId: 'org-1:session-1',
    sessionId: SESSION,
    agent: 'codex',
    paneKey: chatPaneKey(SESSION),
    bot: { kind: 'bot', botId: 'b1' },
    createdAt: 0
  }
  const events: ConversationEvent[] = []
  const turns = new ChatTurns({
    promptsAudience: () => false,
    turnOpener: () => null,
    keepAdoptedTurn: () => {},
    readHookRow: () => null,
    pendingPrompt: () => null,
    chatTurnOrigin: () => 'delivery',
    chatTurnDelivered: () => true,
    chatTurnDelivery: () => undefined,
    chatTurnWaiting: () => false,
    runningTurnReported: () => false,
    workLinks,
    workerActivities: async () => null,
    linkedFor: () => ({ link, workspace: { worktreeId: 'wt', sshHostId: null } }),
    emit: (event) => events.push(event),
    setTimer: () => ({ cancel: () => {} }),
    now: () => 0
  })
  const endTurn = async (at: number) => {
    turns.news({
      kind: 'turn-ended',
      sessionId: SESSION,
      outcome: 'success',
      at,
      readTurn: async () => ({
        lastAssistantMessage: 'Done.',
        opener: {
          itemId: 'public',
          revision: 0,
          sequence: 1,
          observedAt: 1,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [],
            connectorConversation: { source: 'linear', externalId: 'org-1:session-1' }
          }
        }
      })
    })
    await vi.waitFor(() => expect(ended().filter((event) => event.at === at)).toHaveLength(1))
  }
  const ended = () => events.flatMap((event) => (event.kind === 'turn-ended' ? [event] : []))
  const linksOf = () => ended().map((event) => event.links)
  return { endTurn, linksOf }
}

describe('a bot’s Linear thread', () => {
  it('is told each pull request its work opened once, though the work still holds it', async () => {
    const first = { url: 'https://github.com/org/repo/pull/7', title: 'Pull request #7' }
    const second = { url: 'https://github.com/org/repo/pull/8', title: 'Pull request #8' }
    const workLinks = vi
      .fn<() => Promise<ConnectorWorkLink[]>>()
      .mockResolvedValueOnce([first])
      .mockResolvedValue([first, second])
    const thread = linearThread(workLinks)
    await thread.endTurn(1)
    await thread.endTurn(2)
    await thread.endTurn(3)
    expect(thread.linksOf()).toEqual([[first], [second], undefined])
  })
})

describe('a turn end still being read when its watch goes', () => {
  function heardChat() {
    const link: ExternalConversationLink = {
      source: 'slack',
      externalId: 'T1:C1:1',
      sessionId: SESSION,
      agent: 'codex',
      paneKey: chatPaneKey(SESSION),
      createdAt: 0
    }
    const events: ConversationEvent[] = []
    const turns = new ChatTurns({
      promptsAudience: () => false,
      turnOpener: () => null,
      keepAdoptedTurn: () => {},
      readHookRow: () => null,
      pendingPrompt: () => null,
      chatTurnOrigin: () => 'delivery',
      chatTurnDelivered: () => true,
      chatTurnDelivery: () => undefined,
      chatTurnWaiting: () => false,
      runningTurnReported: () => false,
      workLinks: async () => [],
      workerActivities: async () => null,
      linkedFor: () => ({ link, workspace: { worktreeId: 'wt', sshHostId: null } }),
      emit: (event) => events.push(event),
      setTimer: () => ({ cancel: () => {} }),
      now: () => 0
    })
    let read!: () => void
    const turn = new Promise<{ lastAssistantMessage: string }>((resolve) => {
      read = () => resolve({ lastAssistantMessage: 'Done.' })
    })
    turns.news({
      kind: 'turn-ended',
      sessionId: SESSION,
      outcome: 'success',
      at: 1,
      readTurn: () => turn
    })
    // The read's own continuation runs before this one, so the end has been decided by then.
    const readDone = async () => {
      read()
      await turn
    }
    return { turns, events, readDone }
  }

  it('still reaches the next watch', async () => {
    const chat = heardChat()
    chat.turns.clear()
    await chat.readDone()
    await vi.waitFor(() =>
      expect(chat.events).toEqual([
        expect.objectContaining({ kind: 'turn-ended', lastAssistantMessage: 'Done.' })
      ])
    )
  })

  it('reaches no one after an account reset', async () => {
    const chat = heardChat()
    chat.turns.reset()
    await chat.readDone()
    expect(chat.events).toEqual([])
  })
})

describe('a chat unlinked mid-turn', () => {
  it('still closes the turn when it ends, so the chat relinked later names its deliveries', () => {
    const origins: [string, number | null][] = []
    const row = {
      paneKey: chatPaneKey(SESSION),
      structuredHost: 'owned' as const,
      state: 'working' as const
    }
    let linked = true
    const link: ExternalConversationLink = {
      source: 'slack',
      externalId: 'T1:C1:1.1',
      sessionId: SESSION,
      agent: 'codex',
      paneKey: chatPaneKey(SESSION),
      createdAt: 0
    }
    const turns = new ChatTurns({
      promptsAudience: () => false,
      turnOpener: () => null,
      keepAdoptedTurn: () => {},
      readHookRow: () => ({
        ...row,
        tabId: 'tab',
        worktreeId: 'wt',
        connectionId: null,
        prompt: '',
        agentType: 'codex',
        receivedAt: 500,
        stateStartedAt: 500
      }),
      pendingPrompt: () => null,
      chatTurnOrigin: (sessionId, turnAt) => {
        origins.push([sessionId, turnAt])
        return 'delivery'
      },
      chatTurnDelivered: () => true,
      chatTurnDelivery: () => undefined,
      chatTurnWaiting: () => false,
      runningTurnReported: () => false,
      workLinks: async () => [],
      workerActivities: async () => null,
      linkedFor: () => (linked ? { link, workspace: { worktreeId: 'wt', sshHostId: null } } : null),
      emit: () => {},
      setTimer: () => ({ cancel: () => {} }),
      now: () => 0
    })
    turns.observe(chatPaneKey(SESSION))
    linked = false
    turns.news({
      kind: 'turn-ended',
      sessionId: SESSION,
      outcome: 'success',
      at: 600,
      readTurn: async () => ({
        lastAssistantMessage: 'Done.'
      })
    })
    expect(origins).toEqual([[SESSION, 500]])
  })
})

describe('questions of a bot turn typed in Orca (10:27Z regression)', () => {
  it.each(['bot', 'bot-chat'] as const)(
    "adopts a %s chat's Orca-typed turn before showing its question, then posts its answer once a thread message joins it",
    async (kind) => {
      const h = mailStartedBot(kind)
      const turns = h.create()
      turns.observe(h.link.paneKey)
      turns.news({ kind: 'prompt', sessionId: SESSION })
      expect(h.events).toEqual([
        {
          kind: 'turn-started',
          conversation: { source: 'slack', externalId: 'T1:D7:U9' },
          worktreeId: 'folder:bot-home',
          paneKey: chatPaneKey(SESSION),
          at: 500
        },
        expect.objectContaining({
          kind: 'prompt',
          prompt: expect.objectContaining({
            promptId: 'question-1',
            raisedBy: 'orca',
            open: { sessionId: SESSION, itemId: 'question-1' }
          })
        })
      ])
      h.answer()
      h.joinDelivery()
      turns.delivered(h.link.paneKey, SESSION)
      const recreated = h.create()
      expect(recreated.hears(h.link)).toBe(true)
      expect(recreated.adopt(h.link.paneKey)).toBe(500)
      recreated.news({
        kind: 'turn-ended',
        sessionId: SESSION,
        outcome: 'success',
        at: 600,
        readTurn: async () => ({
          lastAssistantMessage: 'Private mail result'
        })
      })
      await vi.waitFor(() =>
        expect(h.events.at(-1)).toEqual({
          kind: 'turn-ended',
          conversation: { source: 'slack', externalId: 'T1:D7:U9' },
          worktreeId: 'folder:bot-home',
          paneKey: chatPaneKey(SESSION),
          turnId: 500,
          stopReason: 'success',
          at: 600,
          origin: 'delivery',
          lastAssistantMessage: 'Private mail result'
        })
      )
      expect(h.link.adoptedTurn).toBeUndefined()
    }
  )

  it('keeps unheard questions and their turn out of an old cloud, including after a downgrade', () => {
    const h = mailStartedBot('bot-chat', false)
    let turns = h.create()
    turns.observe(h.link.paneKey)
    turns.news({ kind: 'prompt', sessionId: SESSION })
    expect(turns.shownPrompt(h.linked, false)).toBeNull()
    expect(h.events).toEqual([])
    h.setCapability(true)
    turns.shownPrompt(h.linked, false)
    h.setCapability(false)
    turns = h.create()
    expect(turns.shownPrompt(h.linked, false)).toBeNull()
    expect(turns.hears(h.link)).toBe(false)
    expect(h.events).toEqual([])
  })

  it('keeps a relinked conversation’s prompt restricted even when its turn has a delivery stamp', () => {
    const h = mailStartedBot('bot-chat')
    h.relink()
    expect(h.create().shownPrompt(h.linked, false)).toMatchObject({ raisedBy: 'orca' })
  })
})

describe('an Orca-typed turn in a chat that posts to its Slack thread', () => {
  function slackThread(
    mirrorTurn: () => { release: (event: ConversationEvent) => void } | null,
    origin: 'local' | 'delivery' = 'local',
    actsFor?: 'owner' | `member:${string}`
  ) {
    const link: ExternalConversationLink = {
      source: 'slack',
      externalId: 'T1:C9:1792.9:U5',
      sessionId: SESSION,
      agent: 'claude',
      paneKey: chatPaneKey(SESSION),
      bot: { kind: 'bot', botId: 'b1' },
      mirror: true,
      createdAt: 0
    }
    const events: ConversationEvent[] = []
    const turns = new ChatTurns({
      promptsAudience: () => true,
      turnOpener: () => null,
      keepAdoptedTurn: () => {},
      readHookRow: () => null,
      pendingPrompt: () => null,
      chatTurnOrigin: () => origin,
      chatTurnDelivered: () => false,
      chatTurnDelivery: () => undefined,
      chatTurnWaiting: () => false,
      runningTurnReported: () => false,
      workLinks: async () => [],
      workerActivities: async () => null,
      mirrorTurn,
      actsForOf: () => actsFor,
      linkedFor: () => ({ link, workspace: { worktreeId: 'wt', sshHostId: null } }),
      emit: (event) => events.push(event),
      setTimer: () => ({ cancel: () => {} }),
      now: () => 0
    })
    turns.news({
      kind: 'turn-ended',
      sessionId: SESSION,
      outcome: 'success',
      at: 5,
      readTurn: async () => ({
        lastAssistantMessage: 'Prod is fine.',
        // Typed in Orca: no conversation's delivery.
        opener: {
          itemId: 'typed',
          revision: 0,
          sequence: 1,
          observedAt: 1,
          body: { kind: 'message', role: 'user', blocks: [] }
        }
      })
    })
    return events
  }

  it("hands the bot's reply, flagged, to the mirror to tell once the owner's post settled", async () => {
    const released: ConversationEvent[] = []
    const events = slackThread(() => ({ release: (event) => released.push(event) }))
    await vi.waitFor(() => expect(released).toHaveLength(1))
    expect(events).toEqual([])
    expect(released[0]).toMatchObject({
      kind: 'turn-ended',
      origin: 'local',
      mirror: true,
      lastAssistantMessage: 'Prod is fine.'
    })
  })

  it("a reply the thread heard still waits behind the owner's steering post", async () => {
    const released: ConversationEvent[] = []
    const events = slackThread(() => ({ release: (event) => released.push(event) }), 'delivery')
    await vi.waitFor(() => expect(released).toHaveLength(1))
    expect(events).toEqual([])
    expect(released[0]).toMatchObject({ origin: 'delivery', lastAssistantMessage: 'Prod is fine.' })
  })

  it('says whom a turn no delivery started acts for, the owner only when Orca recorded it', async () => {
    const turnForOf = async (
      origin: 'local' | 'delivery',
      actsFor?: 'owner' | `member:${string}`
    ) => {
      const released: ConversationEvent[] = []
      slackThread(() => ({ release: (event) => released.push(event) }), origin, actsFor)
      await vi.waitFor(() => expect(released).toHaveLength(1))
      const [ended] = released
      return ended?.kind === 'turn-ended' ? ended.turnFor : null
    }
    expect(await turnForOf('local', 'owner')).toBe('owner')
    expect(await turnForOf('local', 'member:U2')).toBe('someone_else')
    expect(await turnForOf('local')).toBe('someone_else')
    // The cloud reads a delivery's turn from its own record.
    expect(await turnForOf('delivery', 'member:U2')).toBeUndefined()
  })

  it('keeps the reply in Orca when none of its messages posted', async () => {
    const events = slackThread(() => null)
    await vi.waitFor(() =>
      expect(events).toEqual([expect.objectContaining({ kind: 'turn-ended', origin: 'local' })])
    )
    expect(events[0]).not.toHaveProperty('lastAssistantMessage')
    expect(events[0]).not.toHaveProperty('mirror')
  })
})
