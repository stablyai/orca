import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const journal = vi.hoisted(() => {
  const items: unknown[] = []
  return { items }
})
vi.mock('../bots/bot-session-tabs', () => ({
  botOfSession: (_bots: unknown, sessionId: string) =>
    sessionId === 'session-bot1' ? { id: 'bot1', name: 'Reviewer' } : null
}))
vi.mock('../bots/bot-turn-for', () => ({ botTurnFor: async () => 'someone_else' }))
vi.mock('../bots/bot-chat-session', () => ({
  requireStructuredHost: async () => ({
    journalReads: async () => ({
      operationWindow: async () => ({ snapshot: { items: journal.items, submissions: [] } })
    })
  })
}))
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { ConnectorConversation } from '../../shared/connectors/connector-cloud-contract'
import { DeliveryReceipts } from '../external-conversations/external-conversation-delivery-receipts'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import { writeLink } from '../external-conversations/external-conversation-links'
import { readThreadMute } from '../external-conversations/external-conversation-link-writes'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { dispatchDelivery } from './connector-deliveries'
import { handleThreadMute } from './connector-thread-mute'
import { threadMuteSaves } from './connector-thread-mute-saves'
import { CONNECTOR_LEAVE_THREAD_METHOD } from '../runtime/rpc/methods/connector-leave-thread'
import {
  takeThreadLeft,
  THREAD_LEFT_LINE
} from '../external-conversations/external-conversation-thread-leaves'

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
  receipts = new DeliveryReceipts(() => orchestration)
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
    queued: (_key: ConnectorConversation, work?: () => Promise<unknown>) =>
      Promise.resolve(work?.()).then(() => undefined)
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
function leaver(store: ReturnType<typeof createStore>) {
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: leaving reads only these runtime fields.
  const context = {
    runtime: {
      bots: { enabled: () => true },
      lookAround: { botOfTidyUp: () => null, botOfLook: () => null },
      requireStore: () => store,
      getExternalConversationSeam: () => ({
        replyTarget: () => ({ key: FIRST, turnId: TURN_ID }),
        queued: async (_key: unknown, work: () => Promise<unknown>) => {
          await work()
          return undefined
        }
      }),
      getConnectorCloud: () => ({
        reply: async (reply: unknown) => {
          posted.push(reply)
          return { ok: true }
        }
      })
    }
  } as unknown as Parameters<typeof CONNECTOR_LEAVE_THREAD_METHOD.handler>[1]
  const leave = () => CONNECTOR_LEAVE_THREAD_METHOD.handler({ sessionId: 'session-bot1' }, context)
  return { leave, posted }
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

describe('a bot that leaves its thread', () => {
  it('stays left across a restart, for that bot and thread only, until a mention', async () => {
    const store = await botHome({})
    const { leave, posted } = leaver(store)

    expect(await leave()).toEqual({ ok: true })
    // Asked again in the same turn: already left, and still one line to post.
    expect(await leave()).toEqual({ ok: true, already: true })
    await takeThreadLeft('session-bot1', TURN_ID)?.post()
    expect(takeThreadLeft('session-bot1', TURN_ID)).toBeNull()
    expect(posted).toEqual([expect.objectContaining({ text: THREAD_LEFT_LINE, turnId: TURN_ID })])

    await closeTestStores()
    const reopened = createStore()
    expect(readThreadMute(reopened, FIRST)).toEqual({ botId: 'bot1', muted: true })
    expect(readThreadMute(reopened, SECOND)).toEqual({ botId: 'bot2', muted: false })
    expect(readThreadMute(reopened, ELSEWHERE)).toEqual({ botId: 'bot1', muted: false })

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

  it('posts no line once a mention has brought it back', async () => {
    const store = await botHome({})
    const { leave, posted } = leaver(store)
    await leave()
    const { deliver, turns } = connector(store)
    await deliver(send(FIRST, 'wait, one more', { mentioned: true }))
    expect(turns).toEqual(['wait, one more'])
    expect(takeThreadLeft('session-bot1', TURN_ID)).toBeNull()
    expect(posted).toEqual([])
  })

  it('whose save fails is refused, posts nothing, and still wakes on the next reply', async () => {
    const store = await botHome({})
    const { leave, posted } = leaver(store)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(new Error('disk full'))

    await expect(leave()).rejects.toMatchObject({ code: 'thread_mute_not_saved' })
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: false })
    expect(takeThreadLeft('session-bot1', TURN_ID)).toBeNull()
    expect(posted).toEqual([])
    const { deliver, turns } = connector(store)
    await deliver(send(FIRST, 'still there?'))
    expect(turns).toEqual(['still there?'])
  })

  it('changes nothing when no request of the thread is running', async () => {
    const store = await botHome({})
    const { leave } = leaver(store)
    journal.items = []
    await expect(leave()).rejects.toMatchObject({ code: 'leave_refused_stale' })
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: false })
  })
})
