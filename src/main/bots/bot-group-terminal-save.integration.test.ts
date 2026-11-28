import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_THREAD } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { createCodexJournalTranslator } from '../codex/structured/journal/codex-structured-journal-translation'
import { BotGroupStore } from './bot-group-store'
import type { BotGroupRuntime } from './bot-group-runtime'
import type { BotGroupTurn } from '../../shared/bots/bot-group'

const live = vi.hoisted(() => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test setup assigns production-shaped values before each case.
  groups: null as BotGroupRuntime | null,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Test setup assigns the rig host before each case.
  host: null as QueuedMessageTestRig['host'] | null,
  notices: [] as unknown[]
}))

vi.mock('./bot-chat-session', () => ({
  requireStructuredHost: async () => live.host
}))
vi.mock('./bot-group-runtime', () => ({ runtimeBotGroups: () => live.groups }))
vi.mock('./bot-group-mention-handoffs', () => ({ handOffGroupMentions: async () => {} }))

import { noteBotGroupMemberReply } from './bot-group-latest'

const sessionId = 'bot-group-member-fixture'
const member = (operationId: string): BotGroupTurn => ({
  operationId,
  botId: 'bot-1',
  botName: 'Ada',
  avatar: 'A',
  agent: 'codex',
  sessionId
})

let rig: QueuedMessageTestRig
let db: OrchestrationDb
let store: BotGroupStore

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ sessionId })
  db = new OrchestrationDb(':memory:')
  store = new BotGroupStore(db.db)
  store.put({
    id: 'group-1',
    name: 'Crew',
    hostId: 'local',
    revision: 1,
    folder: 'crew',
    folderWorkspaceId: 'home-1',
    createdAt: 1,
    members: [{ botId: 'bot-1', sessionId }],
    replyMode: { kind: 'mentions' }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The callback reads only the store in this fixture.
  live.groups = { store } as BotGroupRuntime
  live.host = rig.host
  live.notices = []
})

afterEach(async () => {
  db.close()
  await rig.dispose()
})

it('persists an ended group turn before the provider close control', async () => {
  const callback = vi.fn((turnId: string) =>
    noteBotGroupMemberReply(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The completion callback needs only this notifier.
      { notifyBotsChanged: (notice: unknown) => live.notices.push(notice) } as never,
      sessionId,
      turnId
    )
  )
  const observed = vi.fn()
  const stop = rig.host.subscribeTurnCompletions({
    id: 'group-terminal-save-test',
    emit: (event) => {
      if (event.type === 'completion') {
        callback(event.completion.turnId)
      }
    },
    onObserved: observed
  })
  try {
    // The queued rig retains the provider after its terminal event.
    const operationId = await rig.workingSend()
    await rig.settleAccepted(operationId, 'finished')
    store.append({
      id: 'post-1',
      groupId: 'group-1',
      text: '@Ada reply',
      createdAt: 1,
      author: { kind: 'owner' },
      turns: [member(operationId)]
    })
    const translator = createCodexJournalTranslator({
      sink: rig.providerEvents(),
      sessionId,
      primaryThreadId: () => HOST_TEST_THREAD
    })
    translator.handle({
      type: 'notification',
      sessionId,
      threadId: HOST_TEST_THREAD,
      method: 'turn/started',
      params: { threadId: HOST_TEST_THREAD, turn: { id: 'turn-finished' } }
    })
    expect(await rig.providerEvents().written?.()).toMatchObject({ ok: true })
    await eventually(() => expect(observed).toHaveBeenCalledWith(sessionId, true))
    translator.handle({
      type: 'notification',
      sessionId,
      threadId: HOST_TEST_THREAD,
      method: 'turn/completed',
      params: { threadId: HOST_TEST_THREAD, turn: { id: 'turn-finished', status: 'completed' } }
    })
    expect(await rig.providerEvents().written?.()).toMatchObject({ ok: true })
    await eventually(async () => {
      expect(callback).toHaveBeenCalledWith('turn-finished')
      expect(store.message('post-1')!.turns[0]).toMatchObject({ end: 'finished', reply: null })
      expect(live.notices).toHaveLength(1)
    })
    expect(rig.closeSession).not.toHaveBeenCalled()
    await rig.closeSession({
      sessionId,
      handle: codexProviderHandle(HOST_TEST_THREAD),
      reason: 'closed'
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The rig accepts the production close shape.
    } as never)
    expect(store.message('post-1')!.turns[0].end).toBe('finished')
    translator.dispose()
  } finally {
    stop()
  }
})
