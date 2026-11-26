import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { botGroupRemoteKey } from '../../shared/bots/bot-group'
import {
  HOST_TEST_NOW,
  HOST_TEST_THREAD,
  hostTestOperationId
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { createQueuedMessageTestRig } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { deliverTurn } from './bot-group-delivery'
import { assertBotGroupQueuedMessageAllowed, runtimeBotGroups } from './bot-group-runtime'
import { makeTestBot } from './bot.test-fixture'

it.each(['resume', 'stop'] as const)(
  'drains the same native waiting group answer after re-enable only if still allowed: %s',
  async (action) => {
    const sessionId = 'bot-group-member-55555555-5555-4555-8555-555555555555'
    const attemptedWhileOff = Promise.withResolvers<void>()
    let runtime: OrcaRuntimeService | undefined
    const rig = await createQueuedMessageTestRig({
      sessionId,
      hostDeps: {
        assertQueuedMessageAllowed: (sessionId, messageId) => {
          if (runtime) {
            try {
              assertBotGroupQueuedMessageAllowed(runtime, sessionId, messageId)
            } finally {
              if (messageId === operationId && !runtime.bots.enabled()) {
                attemptedWhileOff.resolve()
              }
            }
          }
        }
      }
    })
    const operationId = hostTestOperationId()
    onTestFinished(async () => {
      await closeTestStores()
      await rig.dispose()
    })
    const roomDb = new OrchestrationDb(':memory:')
    onTestFinished(() => {
      setStructuredAgentSessionHost(null)
      runtime?.stopOrchestrationFederationRelay()
      roomDb.close()
    })
    const prefs = createSqliteTestStore(Store, {
      dataFile: join(rig.root, 'profile', 'state.json')
    })
    const setEnabled = (botsEnabled: boolean) =>
      prefs.updateSettings({ botsEnabled }, { notifyListeners: true })
    setEnabled(true)
    runtime = new OrcaRuntimeService(prefs)
    runtime.setOrchestrationDb(roomDb)
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    const scout = makeTestBot({ id: 'scout', name: 'Scout' })
    vi.spyOn(runtime.bots, 'list').mockReturnValue([scout])
    setStructuredAgentSessionHost(rig.host)
    const groups = runtimeBotGroups(runtime)
    const groupId = 'crew'
    const remote = {
      botId: 'atlas',
      name: 'Atlas',
      avatar: null,
      agent: 'claude' as const,
      environmentId: 'atlas-host',
      computer: 'Atlas host',
      joinedAfter: 0,
      chatSessionId: '66666666-6666-4666-8666-666666666666'
    }
    groups.store.put({
      id: groupId,
      name: 'Crew',
      folder: rig.root,
      folderWorkspaceId: 'crew',
      hostId: 'local',
      createdAt: 1,
      revision: 1,
      replyMode: { kind: 'mentions' },
      members: [{ botId: scout.id, sessionId }],
      remoteMembers: [remote]
    })
    const root = groups.store.append({
      id: 'root',
      groupId,
      author: { kind: 'owner' },
      text: 'Ask Atlas for a receipt.',
      createdAt: 1,
      turns: []
    })
    const text = 'Atlas confirmed the receipt.'
    const turn = {
      operationId,
      botId: scout.id,
      botName: scout.name,
      sessionId,
      agent: scout.agent,
      avatar: scout.avatar
    }
    const continuation = groups.store.append(
      {
        id: 'group-answer:msg_answer',
        groupId,
        rootRequestId: root.id,
        rootSequence: root.sequence,
        author: { kind: 'bot', id: 'atlas', name: 'Atlas' },
        answeredBy: { id: 'atlas', name: 'Atlas' },
        groupRequest: {
          from: {
            kind: 'remote',
            member: remote,
            requestId: 'msg_ask',
            conversationId: 'peerconv_atlas'
          },
          remoteEdges: []
        },
        text,
        createdAt: 2,
        continuation: true,
        turns: [turn]
      },
      new Map([[operationId, '[]']])
    )

    const running = await rig.workingSend()
    await rig.settleAccepted(running, 'first-turn-input')
    const journal = (await rig.host.conversation(sessionId)).journal
    const identity = {
      provider: 'codex' as const,
      threadId: HOST_TEST_THREAD,
      turnId: 'first-turn',
      ordinal: 0
    }
    const work = {
      kind: 'turn' as const,
      turnId: 'first-turn',
      startedAt: HOST_TEST_NOW,
      userItemId: agentJournalSubmissionKey(running)
    }
    const journalWrite = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    await journal.appendItem(identity, { ...work, state: 'running' }, journalWrite)
    await deliverTurn(groups, continuation, turn)
    expect(await rig.drafts()).toEqual([{ messageId: operationId, state: 'waiting' }])
    expect(groups.store.pendingContext(operationId)).toBeNull()

    setEnabled(false)
    await journal.appendItem(
      identity,
      { ...work, state: 'completed', outcome: 'success', completedAt: HOST_TEST_NOW },
      journalWrite
    )
    await attemptedWhileOff.promise
    expect(await rig.drafts()).toEqual([{ messageId: operationId, state: 'waiting' }])
    expect(await rig.handoff(operationId)).toBeUndefined()
    expect(groups.store.operationMessage(operationId)?.turns[0].error).toBeUndefined()
    expect(rig.dispatch.mock.calls.map(([call]) => call.clientMessageId)).toEqual([running])

    if (action === 'stop') {
      await groups.stop(groupId, botGroupRemoteKey(remote))
    }
    setEnabled(true)
    if (action === 'stop') {
      await vi.waitFor(async () =>
        expect(await rig.drafts()).toEqual([
          { messageId: operationId, state: 'waiting', paused: true }
        ])
      )
      expect(await rig.handoff(operationId)).toBeUndefined()
      expect(groups.store.operationMessage(operationId)?.turns[0].failure?.code).toBe(
        'groupTurnInactive'
      )
      expect(rig.dispatch.mock.calls.map(([call]) => call.clientMessageId)).toEqual([running])
    } else {
      await vi.waitFor(() => expect(rig.dispatch).toHaveBeenCalledTimes(2))
      const sent = await rig.handoff(operationId)
      expect(sent?.queuedMessageId).toBe(operationId)
      const calls = rig.dispatch.mock.calls.map(([call]) => call)
      expect(calls.map((call) => call.clientMessageId)).toEqual([running, sent?.clientMessageId])
      expect(calls[1].body.blocks).toContainEqual(
        expect.objectContaining({ type: 'text', text: expect.stringContaining(text) })
      )
      expect(await rig.drafts()).toEqual([])
    }
  }
)
