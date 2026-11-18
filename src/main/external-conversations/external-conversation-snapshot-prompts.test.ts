import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { z } from 'zod'
import { ConnectorTurnEvents } from '../connector-cloud/connector-turn-events'
import { ConnectorAccountTransport } from '../connector-cloud/connector-transport'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  attach,
  hostTestState,
  seedApproval
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import {
  chatPaneKey,
  type ConversationChat,
  type ConversationChatHost
} from './external-conversation-chat'
import type { ConversationEvent, ConversationSnapshot } from './external-conversation-events'
import type { ExternalConversationHost } from './external-conversation-host'
import { finishTurn } from './external-conversation-provider-turn.test-fixture'
import { harness } from './external-conversation-seam.test-fixture'
import { WORKTREE } from './external-conversation.test-fixture'
import type { ConversationKey } from './external-conversation-types'
import { ShownPrompts } from './external-conversation-snapshot-prompts'

// A reconnect's snapshot keeps a prompt the cloud shows while the chat's journal still holds it.
const KEY: ConversationKey = { source: 'slack', externalId: 'T1:C9:1:U5' }
const PANE = chatPaneKey(HOST_TEST_SESSION)
const APPROVAL_IDENTITY = {
  provider: 'codex' as const,
  threadId: HOST_TEST_THREAD,
  turnId: 'turn-1',
  ordinal: 99
}

type Watched = (ConversationEvent | ConversationSnapshot)[]

/** The chat host the seam reads, swappable: null is a host Orca can't read right now. */
function swappableChats(initial: ConversationChat | null) {
  let installed = initial
  const chats: ConversationChatHost = {
    current: () => installed,
    ensure: async () => installed,
    onChanged: () => () => {}
  }
  return { chats, install: (next: ConversationChat | null) => (installed = next) }
}

/** A thread asked the chat, which asks for approval; the cloud has the card. */
async function askedFromThread() {
  const { host, root } = hostTestState()
  await attach()
  const swap = swappableChats(host)
  const h = harness()
  const conversationHost: ExternalConversationHost = { chat: swap.chats }
  h.seam.linkChat(KEY, { worktreeId: WORKTREE, sessionId: HOST_TEST_SESSION, agent: 'codex' })
  const wire: unknown[] = []
  const queued = new ConnectorTurnEvents(root, 'ada')
  const transport = new ConnectorAccountTransport(
    'https://connector.test',
    async () => ({
      ok: true,
      value: { connectorToken: 'test-credential', expiresAt: Date.now() + 3_600_000 }
    }),
    async (_input, init) => {
      wire.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    }
  )
  const flush = async () => {
    for (let head = queued.next(1); head; head = queued.next(1)) {
      const result = await transport.call('/v1/events', { events: head.batch }, z.undefined(), {
        requests: queued.requestsFor(head.batch)
      })
      if (!result.ok) {
        throw new Error('fake cloud refused events')
      }
      queued.accepted(head.stamp)
    }
  }
  const first: Watched = []
  let releaseWatch = h.seam.watch(conversationHost, (event) => {
    first.push(event)
    queued.observe(event)
  })
  await h.seam.send(conversationHost, KEY, 'd1', { text: 'run it' })
  const { itemId } = await seedApproval('allow')
  await eventually(() =>
    expect(first.at(-1)).toMatchObject({ kind: 'prompt', prompt: { promptId: itemId } })
  )
  await eventually(() =>
    expect(
      Object.hasOwn(host.publishedWork(HOST_TEST_SESSION)?.promptStandings?.items ?? {}, itemId)
    ).toBe(true)
  )
  await flush()
  /** The connector's client goes and a new one watches: its snapshot's entry for the thread. */
  const reconnect = (): ConversationSnapshot['conversations'][number] | undefined => {
    releaseWatch()
    const next: Watched = []
    releaseWatch = h.seam.watch(conversationHost, (event) => {
      next.push(event)
      queued.observe(event)
    })
    const [snapshot] = next
    return snapshot?.kind === 'snapshot' ? snapshot.conversations[0] : undefined
  }
  return {
    ...h,
    host,
    swap,
    itemId,
    conversationHost,
    reconnect,
    flush,
    wire,
    release: () => releaseWatch()
  }
}

async function resolveInJournal(promptId: string): Promise<void> {
  const { host, acquire } = hostTestState()
  acquire.mock.calls.at(-1)?.[0].events?.appendItem(
    APPROVAL_IDENTITY,
    {
      kind: 'approval',
      title: 'Run the command?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: {
        state: 'resolved',
        selectedOptionId: 'allow',
        resolvedBy: 'desktop',
        resolvedAt: HOST_TEST_NOW
      }
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  await eventually(() =>
    expect(host.publishedWork(HOST_TEST_SESSION)?.promptStandings?.items[promptId]).toBeUndefined()
  )
}

async function localTurn(asked: Awaited<ReturnType<typeof askedFromThread>>) {
  await resolveInJournal(asked.itemId)
  const { acquire } = hostTestState()
  const feed = acquire.mock.calls.at(-1)![0].events!
  const scope = { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const identity = { ...APPROVAL_IDENTITY, ordinal: 1 }
  // The thread's turn ends, as the chat's completion feed tells it.
  let ended = false
  const stop = asked.host.subscribeTurnCompletions({
    id: 'test-turn-end',
    emit: (event) => {
      ended ||= event.type === 'completion'
    }
  })
  await finishTurn('Done.', { running: () => {} })
  await eventually(() => expect(ended).toBe(true))
  stop()
  const local = { ...identity, turnId: 'local-turn' }
  feed.appendItem(local, { kind: 'turn', turnId: 'local-turn', state: 'running' }, scope)
  feed.appendItem(
    { ...local, ordinal: 2 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'local request' }] },
    scope
  )
  feed.appendItem(
    { ...local, ordinal: 3 },
    {
      kind: 'question',
      question: 'Private local question?',
      options: [{ id: 'yes', label: 'Yes' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    scope
  )
  await asked.host.flushStreamedEvents(HOST_TEST_SESSION)
  await eventually(() =>
    expect(
      asked.host
        .publishedWork(HOST_TEST_SESSION)
        ?.actionablePrompts.some((item) => item.itemId.endsWith(':local-turn:3'))
    ).toBe(true)
  )
  return { feed, local, scope }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: HOST_TEST_NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a reconnect while a shown prompt is still pending', () => {
  it('keeps the prompt when the new watch cannot read the chat', async () => {
    const asked = await askedFromThread()
    asked.swap.install(null)

    const entry = asked.reconnect()

    expect(entry).toMatchObject({
      paneKey: PANE,
      prompt: { kind: 'approval', promptId: asked.itemId },
      trace: { prompt: 'restated', standing: 'unknown' }
    })
  })

  it('keeps the prompt when the chat reads but cannot vouch for its owner', async () => {
    const asked = await askedFromThread()
    const { store } = hostTestState()
    const conversation = store.getConversation(HOST_TEST_SESSION)!
    const observation = vi.spyOn(store, 'getConversation').mockReturnValue({
      ...conversation,
      currentFence: conversation.currentFence + 1,
      ownerObservation: {
        ...conversation.ownerObservation,
        unreconciled: true,
        provenHandleLinkId: null
      }
    })
    const work = await asked.host.currentWork(HOST_TEST_SESSION)
    observation.mockRestore()
    expect(work?.actionablePrompts()).toEqual([])
    vi.spyOn(asked.host, 'publishedWork').mockImplementation(() => work?.queueState())

    expect(asked.reconnect()).toMatchObject({
      prompt: { promptId: asked.itemId },
      trace: { prompt: 'restated' }
    })
  })

  it('restates the prompt itself, never a turn or work', async () => {
    const asked = await askedFromThread()
    asked.swap.install(null)

    const entry = asked.reconnect()

    expect(entry?.working).toBe(false)
    expect(entry?.turnId).toBeNull()
  })

  it('drops the prompt once the chat proves it over', async () => {
    const asked = await askedFromThread()
    const { store } = hostTestState()
    const conversation = store.getConversation(HOST_TEST_SESSION)!
    const observation = vi.spyOn(store, 'getConversation').mockReturnValue({
      ...conversation,
      ownerObservation: { ...conversation.ownerObservation, claimStatus: 'released' }
    })
    const work = await asked.host.currentWork(HOST_TEST_SESSION)
    observation.mockRestore()
    vi.spyOn(asked.host, 'publishedWork').mockImplementation(() => work?.queueState())
    expect(asked.reconnect()).toMatchObject({
      prompt: null,
      trace: { prompt: 'none', standing: 'gone' }
    })
    // Forgotten: a chat unreadable afterwards doesn't bring it back.
    asked.swap.install(null)
    expect(asked.reconnect()).toMatchObject({ prompt: null })
  })

  it('drops a prompt answered in Orca while no watch ran', async () => {
    const asked = await askedFromThread()
    asked.release()
    await resolveInJournal(asked.itemId)

    expect(asked.reconnect()).toMatchObject({ prompt: null })
  })

  it('keeps a thread-asked turn across a watch gap until that turn ends', async () => {
    const asked = await askedFromThread()
    const ownsTurn = () =>
      asked.seam.conversationTurn(asked.conversationHost.chat, HOST_TEST_SESSION)
    asked.release()
    expect(ownsTurn()).toBe(true)

    await localTurn(asked)
    expect(ownsTurn()).toBe(false)
  })

  it('drops a delivery’s turn when its chat closes mid-turn, so a reopened chat’s turn is the owner’s', async () => {
    const asked = await askedFromThread()
    const ownsTurn = () =>
      asked.seam.conversationTurn(asked.conversationHost.chat, HOST_TEST_SESSION)
    expect(ownsTurn()).toBe(true)

    await asked.host.close(HOST_TEST_SESSION, 'user-close')
    await eventually(() => expect(ownsTurn()).toBe(false))
    asked.release()
  })

  it('never exports a later local turn that began while unwatched', async () => {
    const asked = await askedFromThread()
    asked.release()
    const { feed, local, scope } = await localTurn(asked)
    const received: Watched = []
    const release = asked.seam.watch(asked.conversationHost, (event) => received.push(event))
    expect(received).toEqual([
      expect.objectContaining({
        kind: 'snapshot',
        conversations: [expect.objectContaining({ prompt: null, turnId: null, working: false })]
      })
    ])
    feed.appendItem(
      { ...local, ordinal: 4 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Private result.' }] },
      scope
    )
    feed.appendItem(
      { ...local, ordinal: 5 },
      { kind: 'turn', turnId: 'local-turn', state: 'completed' },
      scope
    )
    await asked.host.flushStreamedEvents(HOST_TEST_SESSION)
    expect(received.filter((event) => event.kind !== 'snapshot')).toEqual([])
    release()
  })

  it('forgets every shown prompt on an account reset', async () => {
    const asked = await askedFromThread()
    asked.swap.install(null)
    asked.seam.resetAccount()

    expect(asked.reconnect()).toMatchObject({ prompt: null })
  })

  it('keeps no prompt a connector answer took, unless the answer did not land', async () => {
    const asked = await askedFromThread()
    await expect(
      asked.seam.answer(asked.conversationHost, KEY, asked.itemId, 'allow')
    ).resolves.toEqual({ outcome: 'accepted' })
    asked.swap.install(null)

    expect(asked.reconnect()).toMatchObject({ prompt: null })
  })
})

describe('the shown prompts a snapshot can restate', () => {
  const approval = { kind: 'approval' as const, promptId: 'p1', tool: 'Bash', options: [] }
  const link = { ...KEY, paneKey: PANE, sessionId: HOST_TEST_SESSION }
  const shownOnce = (): ShownPrompts => {
    const shown = new ShownPrompts()
    shown.offer(link, 'p1').start(approval)(204)
    return shown
  }
  const pending = () => 'pending' as const

  it('restates only for the same chat and pane, and forgets a moved one', () => {
    const shown = shownOnce()
    expect(shown.restate({ ...link, sessionId: 'other' }, pending)).toBeNull()
    expect(shown.restate(link, pending)).toBeNull()
  })

  it('forgets on unlink, turn end and an answer seen in Orca', () => {
    const unlinked = shownOnce()
    unlinked.forgetConversation(KEY)
    expect(unlinked.restate(link, pending)).toBeNull()

    const ended = shownOnce()
    ended.forgetPane(PANE)
    expect(ended.restate(link, pending)).toBeNull()

    const answered = shownOnce()
    answered.forgetPrompt(PANE, 'p1')
    expect(answered.restate(link, pending)).toBeNull()
  })

  it('gives back a prompt whose connector answer failed, but not after an account reset', () => {
    const failed = shownOnce()
    failed.take(PANE, 'p1')()
    expect(failed.restate(link, pending)).toEqual({
      prompt: approval,
      promptId: 'p1',
      standing: 'pending'
    })

    const reset = shownOnce()
    const restore = reset.take(PANE, 'p1')
    reset.reset()
    restore()
    expect(reset.restate(link, pending)).toBeNull()
  })
})

function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// A send in flight across a reconnect keeps its turn: the message it admitted opens the next one.
it('C1-1: an admitted delivery resolving after an account reset cannot own a local turn', async () => {
  const drop = (asked: Awaited<ReturnType<typeof askedFromThread>>) => asked.seam.resetAccount()
  const asked = await askedFromThread()
  const entered = held<void>()
  const resume = held<void>()
  const originalSend = asked.host.send.bind(asked.host)
  const send = vi.spyOn(asked.host, 'send').mockImplementation(async (...args) => {
    const result = await originalSend(...args)
    expect(result.ok).toBe(true)
    entered.resolve()
    await resume.promise
    return result
  })
  const sending = asked.seam.send(asked.conversationHost, KEY, 'held-delivery', {
    text: 'still from the thread'
  })
  try {
    await entered.promise
    drop(asked)
    await localTurn(asked)
    send.mockRestore()
    asked.reconnect()
    await asked.flush()
    expect(asked.wire.at(-1)).toMatchObject({
      events: [{ kind: 'snapshot', conversations: [expect.objectContaining({ prompt: null })] }]
    })
    resume.resolve()
    await sending
    asked.reconnect()
    await asked.flush()
    expect(asked.wire.at(-1)).toMatchObject({
      events: [{ kind: 'snapshot', conversations: [expect.objectContaining({ prompt: null })] }]
    })
    expect(JSON.stringify(asked.wire)).not.toContain('Private local question?')
  } finally {
    resume.resolve()
    await sending
    send.mockRestore()
    asked.seam.dispose('connectors_disabled')
  }
})
