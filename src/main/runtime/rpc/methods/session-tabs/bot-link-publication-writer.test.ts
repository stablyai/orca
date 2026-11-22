import { afterEach, expect, it, vi } from 'vitest'
import {
  createChat,
  host,
  runtime,
  dispatcher,
  store
} from './structured-chat-tab-table.test-fixture'
import {
  HOST_TEST_SESSION,
  HOST_TEST_LOCATION
} from '../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { makeTestBot } from '../../../../bots/bot.test-fixture'
import {
  harness,
  deferred
} from '../../../../external-conversations/external-conversation-seam.test-fixture'
import { writeLink } from '../../../../external-conversations/external-conversation-links'
import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { isOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address'

let conversations: ReturnType<typeof harness> | undefined
afterEach(() => {
  conversations?.seam.dispose('connectors_disabled')
  conversations?.db.close()
})

it.each(['relink', 'unrelated-worker', 'target-worker-removed'] as const)(
  'publishes only while the target authority remains unchanged: %s',
  async (mode) => {
    await createChat(HOST_TEST_SESSION)
    const sessionId = mode === 'relink' ? HOST_TEST_SESSION : 'session-worker'
    if (sessionId !== HOST_TEST_SESSION) {
      await createChat(sessionId)
    }
    await host.setSessionTabVisibility(sessionId, false, undefined, { background: true })
    conversations = harness(undefined, new OrchestrationDb(':memory:'))
    vi.spyOn(runtime.bots, 'list').mockReturnValue([makeTestBot({ id: 'bot' })])
    vi.spyOn(runtime, 'getExternalConversationSeam').mockReturnValue(conversations.seam)
    vi.spyOn(runtime, 'getOrchestrationDb').mockReturnValue(conversations.db)
    conversations.put(HOST_TEST_LOCATION.workspaceId, 'local', {})
    const conversation = { source: 'slack', externalId: 'C1:writer' } as const
    const link = {
      ...conversation,
      sessionId: HOST_TEST_SESSION,
      agent: 'codex' as const,
      paneKey: `chat:${HOST_TEST_SESSION}`,
      bot: { kind: 'bot-chat' as const, botId: 'bot' },
      createdAt: 1
    }
    const workspace = { worktreeId: HOST_TEST_LOCATION.workspaceId, sshHostId: null }
    writeLink(conversations.store, workspace, link)
    if (!isOrcaSessionId(HOST_TEST_SESSION)) {
      throw new Error('invalid fixture session')
    }
    const db = conversations.db
    const worker =
      mode === 'relink'
        ? undefined
        : db.createDispatchContext({
            taskId: db.createTask({ runId: 'run_legacy_local', spec: 'target worker' }).id,
            assigneeHandle: 'orca_session_id:session-worker',
            creator: { kind: 'session', orcaSessionId: HOST_TEST_SESSION },
            maxDepth: 10
          })
    const database = host.deps.journalDatabase
    const effects = database.effects.bind(database)
    const entered = deferred<void>(),
      release = deferred<void>()
    vi.spyOn(database, 'effects').mockImplementation(async (input) => {
      if (
        input.some(
          (effect) =>
            effect.kind === 'store' &&
            effect.mutation.input.kind === 'command' &&
            effect.mutation.input.command.kind === 'tab-visibility' &&
            effect.mutation.input.command.visible
        )
      ) {
        entered.resolve()
        await release.promise
      }
      return effects(input)
    })
    const opening = dispatcher.dispatch(
      {
        id: 'link',
        authToken: 'token',
        method: 'agentSession.reveal',
        params: {
          sessionId,
          navigation: 'caller',
          botLinkTarget: {
            botId: 'bot',
            conversation,
            leadSessionId: HOST_TEST_SESSION,
            sessionId,
            worktreeId: HOST_TEST_LOCATION.workspaceId,
            itemId: 'question-A',
            ...(worker ? { workerDispatchId: worker.id } : {})
          }
        }
      },
      {
        pairedDeviceId: 'phone',
        clientKind: 'mobile',
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
    )
    await entered.promise
    if (mode === 'relink') {
      writeLink(conversations.store, workspace, { ...link, sessionId: 'session-other' })
    } else if (mode === 'unrelated-worker') {
      db.createDispatchContext({
        taskId: db.createTask({ runId: 'run_legacy_local', spec: 'unrelated worker' }).id,
        assigneeHandle: 'orca_session_id:session-unrelated',
        creator: { kind: 'session', orcaSessionId: HOST_TEST_SESSION },
        maxDepth: 10
      })
    } else {
      db.db
        .prepare('UPDATE dispatch_contexts SET creator_orca_session_id = NULL WHERE id = ?')
        .run(worker!.id)
    }
    release.resolve()
    if (mode === 'unrelated-worker') {
      expect(await opening).toMatchObject({
        ok: true,
        result: { ok: true, sessionId: 'session-worker' }
      })
      expect(store.getSessionTabId(sessionId)).not.toBeNull()
      expect((await database.loadRecords()).sessionTabs?.tabIdFor(sessionId)).toBeDefined()
    } else {
      expect(await opening).toMatchObject({
        ok: false,
        error: { message: 'bot_link_target_changed' }
      })
      expect(store.getSessionTabId(sessionId)).toBeNull()
      expect((await database.loadRecords()).sessionTabs?.tabIdFor(sessionId)).toBeUndefined()
    }
  }
)
