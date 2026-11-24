import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const journal = vi.hoisted(() => {
  const items: unknown[] = []
  // What the leave's read of its turn waits on, when a test holds it.
  const reading: { held: Promise<unknown> } = { held: Promise.resolve() }
  return { items, reading }
})
vi.mock('../bots/bot-session-tabs', () => ({
  botOfSession: (_bots: unknown, sessionId: string) =>
    sessionId === 'session-bot1' ? { id: 'bot1', name: 'Reviewer' } : null
}))
vi.mock('../bots/bot-chat-session', () => ({
  requireStructuredHost: async () => ({
    journalReads: async () => ({
      operationWindow: async () => {
        await journal.reading.held
        return { snapshot: { items: journal.items, submissions: [] } }
      }
    })
  })
}))
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { ConnectorConversation } from '../../shared/connectors/connector-cloud-contract'
import { DeliveryReceipts } from '../external-conversations/external-conversation-delivery-receipts'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import { findLink, writeLink } from '../external-conversations/external-conversation-links'
import { readThreadMute } from '../external-conversations/external-conversation-link-writes'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { ConversationChain } from '../external-conversations/external-conversation-chain'
import { dispatchDelivery } from './connector-deliveries'
import { handleThreadMute, type ThreadMuteDeps } from './connector-thread-mute'
import { threadMuteSaves, threadMuteSaving } from './connector-thread-mute-saves'
import { ProfileStateIndeterminateWriteError } from '../persistence/profile-state/database/profile-state-write-transaction'
import { CONNECTOR_LEAVE_THREAD_METHOD } from '../runtime/rpc/methods/connector-leave-thread'
import {
  leaveLines,
  THREAD_LEFT_LINE
} from '../external-conversations/external-conversation-leave-lines'

const THREAD = 'T1:C1:1800000000.000100'
const FIRST: ConnectorConversation = { source: 'slack', externalId: `${THREAD}:U0BOT` }
const SECOND: ConnectorConversation = { source: 'slack', externalId: `${THREAD}:U0TWO` }
// The first bot's link to another thread in the same channel.
const ELSEWHERE: ConnectorConversation = {
  source: 'slack',
  externalId: 'T1:C1:1800000000.000900:U0BOT'
}

let sent = 0
const send = (conversation: ConnectorConversation, text: string, extra = {}) => ({
  kind: 'send',
  deliveryId: `d${++sent}`,
  expiresAt: 1_900_000_000_000,
  conversation,
  text,
  asker: {
    userId: 'U1',
    role: 'member',
    place: { kind: 'public_channel', id: 'C1' },
    text,
    context: [],
    messageRef: `slack:${THREAD}:1800000000.000${200 + sent}`
  },
  ...extra
})

let orchestration: OrchestrationDb

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-thread-mute-'))
  orchestration = new OrchestrationDb(join(testState.dir, 'orchestration.db'))
})

afterEach(async () => {
  orchestration.close()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

/** A bot home with two bots following one Slack thread, each on its own link. */
async function botHome(muted: { first?: true; second?: true }) {
  const store = createStore()
  const group = store.createProjectGroup({
    name: 'Bots',
    parentPath: testState.dir,
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'manual'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    folderPath: testState.dir
  })
  const workspace = { worktreeId: folderWorkspaceKey(folder.id), sshHostId: null }
  for (const [key, botId, pane, isMuted] of [
    [FIRST, 'bot1', 'pane-1', muted.first],
    [SECOND, 'bot2', 'pane-2', muted.second],
    [ELSEWHERE, 'bot1', 'pane-3', undefined]
  ] as const) {
    writeLink(store, workspace, {
      ...key,
      sessionId: `session-${botId}`,
      agent: 'claude',
      paneKey: pane,
      bot: { kind: 'bot', botId },
      createdAt: 1,
      ...(isMuted ? { muted: true } : {})
    })
  }
  await store.flushPendingOrThrowAsync()
  return store
}

/** The real mute path between the real store and receipts; only the agent's turn is a stand-in. */
function connector(
  store: ReturnType<typeof createStore>,
  receipts = new DeliveryReceipts(() => orchestration),
  mentionsKnown = true,
  queue?: ThreadMuteDeps['queued'],
  // The bots set to answer their threads only when mentioned.
  mentionsOnly: readonly string[] = []
) {
  const turns: string[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mute path calls only these seam members.
  const seam = {
    receipts,
    // As the real seam does, a turn runs under its own durable receipt.
    send: (_host: unknown, key: ConnectorConversation, id: string, message: { text: string }) =>
      receipts.run(key, id, 'connector.send', [message.text], async () => {
        turns.push(message.text)
        return { outcome: 'accepted' }
      })
  } as unknown as ExternalConversationSeam
  const deps = {
    waiting: new Map<string, Promise<unknown>>(),
    read: (key: ConnectorConversation) => readThreadMute(store, key),
    write: threadMuteSaves(store),
    saving: threadMuteSaving,
    mentionsKnown: () => mentionsKnown,
    mentionsOnly: (botId: string | null) =>
      botId === null ? mentionsOnly.length > 0 : mentionsOnly.includes(botId),
    queued:
      queue ??
      ((_key: ConnectorConversation, work?: () => Promise<unknown>) =>
        Promise.resolve(work?.()).then(() => undefined))
  }
  const machine = {
    runTrigger: async () => false,
    threadMute: (
      delivery: Parameters<typeof handleThreadMute>[1],
      record: Parameters<typeof handleThreadMute>[2],
      carriedBefore?: Promise<boolean>
    ) => handleThreadMute(deps, delivery, record, carriedBefore)
  }
  const deliver = async (raw: unknown) =>
    await dispatchDelivery(
      seam,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stand-in seam never reads its host.
      {} as ExternalConversationHost,
      machine,
      raw,
      () => 60_000
    )?.done
  return { deliver, turns }
}

const TURN_ID = 1_800_000_000_300

/** `orca bot reply --leave-thread` from bot1's chat, which answers FIRST, while a member's request
 *  in that thread runs. */
function leaver(
  store: ReturnType<typeof createStore>,
  ahead: Promise<unknown> = Promise.resolve(),
  queue?: (
    key: ConnectorConversation,
    work: (signal: AbortSignal) => Promise<unknown>
  ) => Promise<unknown>
) {
  journal.items = [
    {
      itemId: 'u1',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'message',
        role: 'user',
        text: 'thanks, you can leave this thread now',
        origin: 'connector',
        asker: { role: 'member', userId: 'U1', messageRef: `slack:${THREAD}:1800000000.000250` },
        connectorConversation: FIRST,
        leaveEligible: true
      }
    },
    {
      itemId: 't1',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'p1', state: 'running', userItemId: 'u1' }
    }
  ]
  const posted: unknown[] = []
  const features = ['sends.mentioned']
  // The cloud's hello answered (else its features are unknown), and the turn end still queued for it.
  const cloudState = { answered: true, endPending: false }
  // What the cloud answers each post, in turn; it posts while it answers ok.
  const answers: ({ ok: true } | { ok: false; status: number | null; error: string | null })[] = []
  const cloud = {
    cloudFeatures: () => (cloudState.answered ? new Set(features) : null),
    turnEndPending: () => cloudState.endPending,
    reply: async (reply: unknown) => {
      const answer = answers.shift() ?? { ok: true as const }
      if (answer.ok) {
        posted.push(reply)
      }
      return answer
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: leaving reads only these runtime fields.
  const context = {
    runtime: {
      bots: { enabled: () => true },
      lookAround: { botOfTidyUp: () => null, botOfLook: () => null },
      requireStore: () => store,
      // A cloud that marks a reply mentioning the bot, so a mention can bring it back.
      getConnectorCloud: () => ({ cloudFeatures: () => new Set(features) }),
      getExternalConversationSeam: () => ({
        replyTarget: () => ({ key: FIRST, turnId: TURN_ID }),
        // The thread's queue: deliveries ahead of the leave run first.
        queued:
          queue ??
          (async (_key: unknown, work: (signal: AbortSignal) => Promise<unknown>) => {
            await ahead
            await work(new AbortController().signal)
            return undefined
          })
      })
    }
  } as unknown as Parameters<typeof CONNECTOR_LEAVE_THREAD_METHOD.handler>[1]
  // As Orca verified the caller: the bot's own chat, unless a test names another.
  const leave = (caller = 'session-bot1') =>
    CONNECTOR_LEAVE_THREAD_METHOD.handler(
      { sessionId: 'session-bot1' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller identity this method reads.
      { ...context, orchestrationCaller: { sessionId: caller } } as typeof context
    )
  // What the turn's end, or a restart, posts with.
  const timers: (() => void)[] = []
  const lines = (on = store) =>
    leaveLines({
      store: on,
      cloud: () => cloud,
      setTimer: (run) => timers.push(run),
      flush: () => on.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    })
  const link = () => findLink(store, FIRST)!.link
  return { leave, posted, lines, link, answers, timers, features, cloudState }
}

describe('a muted bot thread', () => {
  it('admits no unmentioned reply, and one turn for a mention that unmutes it on disk', async () => {
    const store = await botHome({ first: true })
    const { deliver, turns } = connector(store)

    const quiet = send(FIRST, 'fyi, the build is green')
    expect(await deliver(quiet)).toEqual({ outcome: 'accepted' })
    expect(await deliver(quiet)).toEqual({ outcome: 'accepted' })
    // Nor do the automations it matched: the cloud is told they were taken, so it starts none.
    const automations = [
      {
        automationId: 'auto-1',
        triggerId: 't1',
        botId: 'bot1',
        event: { key: THREAD, actorId: 'U1', occurredAt: 1_800_000_000_000, text: 'deploy done' }
      }
    ]
    const matched = send(FIRST, 'deploy done', { automations })
    const taken = { outcome: 'accepted', inTurn: true }
    expect(await deliver(matched)).toEqual(taken)
    expect(await deliver(matched)).toEqual(taken)
    expect(turns).toEqual([])

    // The mention was stripped from its words: only the flag says it was there.
    const mention = send(FIRST, 'can you look at the failing test', { mentioned: true })
    expect(await deliver(mention)).toEqual({ outcome: 'accepted' })
    expect(await deliver(mention)).toEqual({ outcome: 'accepted' })
    expect(turns).toEqual(['can you look at the failing test'])
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: false })

    await closeTestStores()
    const reopened = createStore()
    expect(readThreadMute(reopened, FIRST)).toEqual({ botId: 'bot1', muted: false })
    expect(readThreadMute(reopened, SECOND)).toEqual({ botId: 'bot2', muted: false })
  })

  it('is one thread: a mention in another thread leaves it as it is', async () => {
    const store = await botHome({ first: true })
    const { deliver, turns } = connector(store)
    await deliver(send(ELSEWHERE, 'look here too', { mentioned: true }))
    await deliver(send(FIRST, 'fyi'))
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: true })
    await deliver(send(FIRST, 'can you look', { mentioned: true }))
    await deliver(send(FIRST, 'thanks'))
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: false })
    expect(turns).toEqual(['look here too', 'can you look', 'thanks'])
  })
})

describe('a bot set to answer its threads only when mentioned', () => {
  it('admits one turn per mention in every thread of its, with nothing kept on the thread', async () => {
    const store = await botHome({})
    const { deliver, turns } = connector(store, undefined, true, undefined, ['bot1'])

    const quiet = send(FIRST, 'fyi, the build is green')
    expect(await deliver(quiet)).toEqual({ outcome: 'accepted' })
    // A resend replays the silence, never decided again.
    expect(await deliver(quiet)).toEqual({ outcome: 'accepted' })
    await deliver(send(ELSEWHERE, 'same over here'))
    expect(turns).toEqual([])

    const mention = send(FIRST, 'can you look at the failing test', { mentioned: true })
    expect(await deliver(mention)).toEqual({ outcome: 'accepted' })
    expect(await deliver(mention)).toEqual({ outcome: 'accepted' })
    await deliver(send(FIRST, 'thanks'))
    // The other bot following the same thread still answers every reply.
    await deliver(send(SECOND, 'and you?'))
    expect(turns).toEqual(['can you look at the failing test', 'and you?'])
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: false })
  })

  it('answers every reply again once the setting is off', async () => {
    const store = await botHome({})
    const only = ['bot1']
    const { deliver, turns } = connector(store, undefined, true, undefined, only)
    await deliver(send(FIRST, 'fyi'))
    only.length = 0
    await deliver(send(FIRST, 'what do you think?'))
    expect(turns).toEqual(['what do you think?'])
  })
})

describe('a bot that leaves its thread', () => {
  it('stays left across a restart, for that bot and thread only, until a mention', async () => {
    const store = await botHome({})
    const { leave, posted, lines } = leaver(store)

    expect(await leave()).toEqual({ ok: true })
    // Asked again in the same turn: already left, and its line is owed once.
    expect(await leave()).toEqual({ ok: true, already: true })
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: true, leaveLine: TURN_ID })

    // Orca quit before the turn ended: the line owed is posted once it watches again, then no more.
    await closeTestStores()
    const reopened = createStore()
    expect(readThreadMute(reopened, FIRST)).toEqual({
      botId: 'bot1',
      muted: true,
      leaveLine: TURN_ID
    })
    expect(readThreadMute(reopened, SECOND)).toEqual({ botId: 'bot2', muted: false })
    expect(readThreadMute(reopened, ELSEWHERE)).toEqual({ botId: 'bot1', muted: false })
    lines(reopened).resume(() => null)
    await expect.poll(() => posted.length).toBe(1)
    lines(reopened).resume(() => null)
    expect(posted).toEqual([
      expect.objectContaining({ text: THREAD_LEFT_LINE, turnId: TURN_ID, turnFor: 'none' })
    ])
    expect(readThreadMute(reopened, FIRST)).toEqual({ botId: 'bot1', muted: true })

    const after = connector(reopened)
    const quiet = send(FIRST, 'thanks all')
    expect(await after.deliver(quiet)).toEqual({ outcome: 'accepted' })
    expect(await after.deliver(quiet)).toEqual({ outcome: 'accepted' })
    await after.deliver(send(SECOND, 'thanks all'))
    await after.deliver(send(ELSEWHERE, 'and here'))
    expect(after.turns).toEqual(['thanks all', 'and here'])
    await after.deliver(send(FIRST, 'one more thing', { mentioned: true }))
    expect(after.turns).toEqual(['thanks all', 'and here', 'one more thing'])
    expect(readThreadMute(reopened, FIRST)).toEqual({ botId: 'bot1', muted: false })
  })

  it('owes no line once a mention has brought it back, and can leave again in that turn', async () => {
    const store = await botHome({})
    const { leave, posted, lines, link } = leaver(store)
    await leave()
    const { deliver, turns } = connector(store)
    await deliver(send(FIRST, 'wait, one more', { mentioned: true }))
    expect(turns).toEqual(['wait, one more'])
    expect(lines().owed(link(), TURN_ID)).toBe(false)
    lines().resume(() => null)
    expect(posted).toEqual([])
    // Asked again in the same turn: it leaves again, never "already".
    expect(await leave()).toEqual({ ok: true })
    expect(lines().owed(link(), TURN_ID)).toBe(true)
  })

  it('whose save fails is refused, owes nothing, and silences no reply sent meanwhile', async () => {
    const store = await botHome({})
    const { leave, posted, lines, link } = leaver(store)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let fail = (): void => {}
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = () => reject(new Error('disk full'))))
    )
    const { deliver, turns } = connector(store)

    const leaving = leave()
    await expect.poll(() => readThreadMute(store, FIRST)).toMatchObject({ muted: true })
    // Asked again while it saves: answered as what was saved, never "already" first.
    const again = leave()
    // A turn end posting its line while the save is on its way waits for it.
    lines().post(link(), TURN_ID)
    for (let tick = 0; tick < 10; tick++) {
      await Promise.resolve()
    }
    expect(posted).toEqual([])
    // A reply while the save is on its way waits for it, so the failed save swallows nothing.
    const replied = deliver(send(FIRST, 'still there?'))
    fail()
    await expect(leaving).rejects.toMatchObject({ code: 'thread_mute_not_saved' })
    await expect(again).rejects.toMatchObject({ code: 'thread_mute_not_saved' })
    await replied
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: false })
    expect(lines().owed(link(), TURN_ID)).toBe(false)
    expect(posted).toEqual([])
    expect(turns).toEqual(['still there?'])
  })

  it('keeps a line that couldn\u2019t post owed until it posts, and drops one refused for good', async () => {
    const store = await botHome({})
    const { leave, posted, lines, link, answers, timers } = leaver(store)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await leave()
    const own = lines()
    // A turn end deciding its line holds it from a reconnect's resume.
    own.ending(link(), TURN_ID)
    own.resume(() => null)
    expect(posted).toEqual([])
    // Checked again once that end's hold runs out, in case it never finished.
    const recheck = timers.shift()!
    // Busy past every listed wait: still owed, and the next watch posts it once.
    answers.push(
      ...Array.from({ length: 7 }, () => ({ ok: false as const, status: 503, error: null }))
    )
    own.post(link(), TURN_ID)
    for (let tries = 0; tries < 6; tries++) {
      await expect.poll(() => timers.length).toBe(1)
      timers.shift()!()
    }
    // The last wait ran out: it says so, and is still owed.
    await expect
      .poll(() => warn.mock.calls.some(([said]) => String(said).includes('could not post')))
      .toBe(true)
    expect(own.owed(link(), TURN_ID) && timers.length === 0).toBe(true)
    expect(posted).toEqual([])
    own.resume(() => null)
    await expect.poll(() => posted.length).toBe(1)
    expect(own.owed(link(), TURN_ID)).toBe(false)
    recheck()
    expect(posted).toHaveLength(1)
  })

  it('posts a line once the cloud took its turn end, and keeps it owed where mentions go unmarked', async () => {
    const store = await botHome({})
    const { leave, posted, lines, link, features, cloudState, timers } = leaver(store)
    await leave()
    const own = lines()
    // Its answer's end is still queued for the cloud (after a restart too): nothing posts, even when
    // a watch or the fallback tries.
    cloudState.endPending = true
    own.afterTurnEnd(link(), TURN_ID, true)
    timers.shift()!()
    // It waits and looks again later.
    await expect.poll(() => timers.length).toBe(1)
    timers.shift()!()
    await expect.poll(() => timers.length).toBe(1)
    // A hello not answered yet: whether mentions are marked is unknown, so it waits and tries again.
    cloudState.endPending = false
    cloudState.answered = false
    timers.shift()!()
    await expect.poll(() => timers.length).toBe(1)
    expect(posted).toEqual([])
    cloudState.answered = true
    // A cloud that stopped marking mentions: saying so would be false, so it waits, still owed.
    features.length = 0
    own.turnEndsTaken([{ kind: 'turn-ended', conversation: FIRST, turnId: TURN_ID }])
    await expect.poll(() => own.owed(link(), TURN_ID)).toBe(true)
    expect(posted).toEqual([])
    features.push('sends.mentioned')
    own.post(link(), TURN_ID)
    await expect.poll(() => posted.length).toBe(1)
    expect(own.owed(link(), TURN_ID)).toBe(false)
  })

  it('keeps a leave whose save may have reached disk, and says it is unconfirmed', async () => {
    const store = await botHome({})
    const { leave, lines, link, posted, timers } = leaver(store)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unknown = () =>
      new ProfileStateIndeterminateWriteError(new Error('commit unacknowledged'), undefined)
    const flush = vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(unknown())
    await expect(leave()).rejects.toMatchObject({ code: 'leave_unconfirmed' })
    // As disk may hold it: a restart can't bring back a mute memory had dropped.
    expect(readThreadMute(store, FIRST)).toMatchObject({ muted: true })
    // Asked again: saved again before it says so.
    await expect(leave()).resolves.toEqual({ ok: true, already: true })
    expect(flush).toHaveBeenCalledTimes(2)
    // Its line posts only after a save known to be on disk.
    flush.mockRejectedValueOnce(unknown())
    lines().post(link(), TURN_ID)
    await expect.poll(() => timers.length).toBe(1)
    expect(posted).toEqual([])
    timers.shift()!()
    await expect.poll(() => posted.length).toBe(1)
  })

  it('drops a line the cloud refuses for good', async () => {
    const store = await botHome({})
    const { leave, posted, lines, link, answers, timers } = leaver(store)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await leave()
    answers.push({ ok: false, status: 404, error: 'not_this_hosts_thread' })
    lines().post(link(), TURN_ID)
    await expect.poll(() => lines().owed(link(), TURN_ID)).toBe(false)
    expect(posted).toEqual([])
    expect(timers).toEqual([])
    expect(readThreadMute(store, FIRST)).toMatchObject({ muted: true })
  })

  it('silences a reply sent while the leave waits its turn in the thread\u2019s queue', async () => {
    const store = await botHome({})
    let go = (): void => {}
    const { leave } = leaver(store, new Promise<void>((resolve) => (go = resolve)))
    const { deliver, turns } = connector(store)

    const leaving = leave()
    const replied = deliver(send(FIRST, 'sounds good, thanks'))
    go()
    expect(await leaving).toEqual({ ok: true })
    expect(await replied).toEqual({ outcome: 'accepted' })
    expect(turns).toEqual([])
  })

  it('never stalls the thread when a reply lands while the leave reads its turn', async () => {
    const store = await botHome({})
    // One real thread queue for the leave and the replies.
    const chain = new ConversationChain(new AbortController().signal)
    const queue = (_key: ConnectorConversation, work?: (signal: AbortSignal) => Promise<unknown>) =>
      chain.after('thread', work)
    let read = (): void => {}
    journal.reading.held = new Promise<void>((resolve) => (read = resolve))
    const { leave } = leaver(store, undefined, queue)
    const { deliver, turns } = connector(store, undefined, true, queue)

    const leaving = leave()
    const replied = deliver(send(FIRST, 'great, thanks'))
    read()
    expect(await leaving).toEqual({ ok: true })
    expect(await replied).toEqual({ outcome: 'accepted' })
    expect(turns).toEqual([])
    journal.reading.held = Promise.resolve()
  })

  it('never leaves for a chat other than the one asking', async () => {
    const store = await botHome({})
    const { leave } = leaver(store)
    await expect(leave('session-bot2')).rejects.toMatchObject({ code: 'not_a_bot_session' })
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: false })
  })

  it('never saves after a Stop that landed while it read its turn', async () => {
    const store = await botHome({})
    const chain = new ConversationChain(new AbortController().signal)
    let read = (): void => {}
    journal.reading.held = new Promise<void>((resolve) => (read = resolve))
    let began = (): void => {}
    const running = new Promise<void>((resolve) => (began = resolve))
    const { leave } = leaver(store, undefined, (_key, work) =>
      chain.after('thread', async (signal) => {
        began()
        return await work(signal)
      })
    )

    const leaving = leave()
    await running
    // The read lands right as the Stop does, before the Stop's answer reaches the leave.
    void chain.cancel('thread', 'conversation_cancelled')
    read()
    await expect(leaving).rejects.toMatchObject({ code: 'thread_mute_not_saved' })
    journal.reading.held = Promise.resolve()
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: false })
  })

  it('never leaves on a cloud that can\u2019t say a reply @mentioned it', async () => {
    const store = await botHome({})
    const { leave, features } = leaver(store)
    features.length = 0
    await expect(leave()).rejects.toMatchObject({ code: 'leave_unavailable' })
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: false })
  })

  it('lets every reply through on a cloud that no longer marks mentions', async () => {
    const store = await botHome({ first: true })
    const { deliver, turns } = connector(store, undefined, false)
    await deliver(send(FIRST, 'please check this'))
    expect(turns).toEqual(['please check this'])
    expect(readThreadMute(store, FIRST)).toMatchObject({ muted: true })
    // A bare @mention it still names brings the bot back for good, before mentions are marked again.
    await deliver(send(FIRST, '@Ranger', { bareMention: true }))
    expect(readThreadMute(store, FIRST)).toMatchObject({ muted: false })
  })

  it('after a quit, posts the line once its answer has left the reply outbox', async () => {
    const store = await botHome({})
    const { leave, posted, timers } = leaver(store)
    await leave()
    await closeTestStores()
    const reopened = createStore()
    const linked = () => findLink(reopened, FIRST)!.link
    // The turn's answer is still in the reply outbox, waiting for the cloud.
    const outbox = { holdsAnswer: true }
    const restarted = leaveLines({
      store: reopened,
      cloud: () => ({
        cloudFeatures: () => new Set(['sends.mentioned']),
        reply: async (reply: unknown) => {
          posted.push(reply)
          return { ok: true as const }
        }
      }),
      setTimer: (run) => timers.push(run),
      answerPending: async () => outbox.holdsAnswer
    })
    restarted.resume(() => null)
    await expect.poll(() => readThreadMute(reopened, FIRST)).toMatchObject({ muted: true })
    await Promise.resolve()
    expect(posted).toEqual([])
    expect(restarted.owed(linked(), TURN_ID)).toBe(true)
    // The cloud took the answer: the line follows it, once.
    outbox.holdsAnswer = false
    restarted.turnEndsTaken([{ kind: 'turn-ended', conversation: FIRST, turnId: TURN_ID }])
    await expect.poll(() => posted.length).toBe(1)
    expect(restarted.owed(linked(), TURN_ID)).toBe(false)
    restarted.resume(() => null)
    await Promise.resolve()
    expect(posted).toHaveLength(1)
  })

  it('posts no line when an @mention brought it back while it looked for the answer', async () => {
    const store = await botHome({})
    const { leave, posted, link, timers } = leaver(store)
    await leave()
    const lines = leaveLines({
      store,
      cloud: () => ({
        cloudFeatures: () => new Set(['sends.mentioned']),
        reply: async (reply: unknown) => {
          posted.push(reply)
          return { ok: true as const }
        }
      }),
      setTimer: (run) => timers.push(run),
      answerPending: async () => {
        await threadMuteSaves(store)(FIRST, false)
        checked.done = true
        return false
      }
    })
    const checked = { done: false }
    lines.post(link(), TURN_ID)
    await expect.poll(() => checked.done).toBe(true)
    // The attempt goes on in the same few ticks; it would have posted by now.
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
    }
    expect(readThreadMute(store, FIRST)).toMatchObject({ muted: false })
    expect(posted).toEqual([])
  })

  it('changes nothing when no request of the thread is running', async () => {
    const store = await botHome({})
    const { leave } = leaver(store)
    journal.items = []
    await expect(leave()).rejects.toMatchObject({ code: 'leave_refused_stale' })
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: false })
  })
})
