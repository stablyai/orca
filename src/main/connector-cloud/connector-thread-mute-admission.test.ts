import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const THREAD = 'T1:C1:1800000000.000100'
const FIRST: ConnectorConversation = { source: 'slack', externalId: `${THREAD}:U0BOT` }
const SECOND: ConnectorConversation = { source: 'slack', externalId: `${THREAD}:U0TWO` }

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
    [SECOND, 'bot2', 'pane-2', muted.second]
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

/** The real mute path between the real store and receipts; only the agent's turn and the emoji are
 *  stand-ins. */
function connector(store: ReturnType<typeof createStore>) {
  const receipts = new DeliveryReceipts(() => orchestration)
  const turns: string[] = []
  const reacted: string[] = []
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
    botNames: (botId: string) => (botId === 'bot1' ? ['Reviewer'] : ['Builder']),
    queued: (_key: ConnectorConversation, work?: () => Promise<unknown>) =>
      Promise.resolve(work?.()).then(() => undefined),
    react: async (_bot: string, _key: ConnectorConversation, ref: string, emoji: string) => {
      reacted.push(`${ref} ${emoji}`)
    }
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
  return { deliver, turns, reacted }
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

  it('stays muted across a restart, for that bot only', async () => {
    const store = await botHome({})
    const { deliver, turns, reacted } = connector(store)

    const directive = send(SECOND, 'Builder stop listening to this thread.')
    expect(await deliver(directive)).toEqual({ outcome: 'accepted' })
    expect(await deliver(directive)).toEqual({ outcome: 'accepted' })
    expect(reacted).toEqual([`${directive.asker.messageRef} :mute:`])

    await closeTestStores()
    const reopened = createStore()
    expect(readThreadMute(reopened, SECOND)).toEqual({ botId: 'bot2', muted: true })
    expect(readThreadMute(reopened, FIRST)).toEqual({ botId: 'bot1', muted: false })

    const after = connector(reopened)
    await after.deliver(send(SECOND, 'thanks all'))
    await after.deliver(send(FIRST, 'thanks all'))
    expect([...turns, ...after.turns]).toEqual(['thanks all'])
  })
})

describe('a mute whose save fails', () => {
  // Refused, so the thread offers Send again; nothing is confirmed until a save lands.
  it('is refused with nothing confirmed, and mutes when it is sent again', async () => {
    const store = await botHome({})
    const { deliver, reacted } = connector(store)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(new Error('disk full'))

    const directive = send(FIRST, 'stop listening here')
    expect(await deliver(directive)).toEqual({
      outcome: 'refused',
      reason: 'thread_mute_not_saved'
    })
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: false })
    expect(reacted).toEqual([])

    expect(await deliver(directive)).toEqual({ outcome: 'accepted' })
    expect(readThreadMute(store, FIRST)).toEqual({ botId: 'bot1', muted: true })
    expect(reacted).toHaveLength(1)
  })
})
