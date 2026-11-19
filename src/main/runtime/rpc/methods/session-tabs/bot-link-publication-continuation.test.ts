import { afterEach, expect, it, vi } from 'vitest'
import {
  createChat,
  host,
  runtime,
  dispatcher,
  store,
  WORKTREE
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
import {
  openStructuredAgentSession,
  structuredSessionOpenFailure
} from '../../../../../shared/agent-session/view/open-structured-agent-session'

let conversations: ReturnType<typeof harness> | undefined
afterEach(() => {
  conversations?.seam.dispose('connectors_disabled')
  conversations?.db.close()
  conversations = undefined
})

it.each(['control', 'after-publication', 'after-caller-reopen'] as const)(
  'reports committed visibility truthfully when opening continues: %s',
  async (mode) => {
    await createChat(HOST_TEST_SESSION)
    await createChat('session-other')
    await host.setSessionTabVisibility(HOST_TEST_SESSION, false, undefined, { background: true })
    conversations = harness(undefined, new OrchestrationDb(':memory:'))
    vi.spyOn(runtime.bots, 'list').mockReturnValue([makeTestBot({ id: 'bot' })])
    vi.spyOn(runtime, 'getExternalConversationSeam').mockReturnValue(conversations.seam)
    conversations.put(HOST_TEST_LOCATION.workspaceId, 'local', {})
    const conversation = { source: 'slack', externalId: 'C1:postcommit' } as const
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
    const phone = {
      pairedDeviceId: 'phone',
      clientKind: 'mobile' as const,
      clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
    }
    runtime.selectCreatedMobileSessionTabForClient(
      HOST_TEST_LOCATION.workspaceId,
      { sessionId: 'session-other' },
      phone.pairedDeviceId
    )
    const before = await runtime.listMobileSessionTabs(WORKTREE, phone.pairedDeviceId)
    const entered = deferred<void>(),
      release = deferred<void>()
    const publish = runtime.publishStructuredAgentSessionTab.bind(runtime)
    vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockImplementation(async (input) => {
      await publish(input)
      if (mode === 'after-publication') {
        entered.resolve()
        await release.promise
      }
    })
    const reopen = runtime.reopenMobileSessionTabForClient.bind(runtime)
    vi.spyOn(runtime, 'reopenMobileSessionTabForClient').mockImplementation(async (...args) => {
      const result = await reopen(...args)
      if (mode === 'after-caller-reopen') {
        entered.resolve()
        await release.promise
      }
      return result
    })
    let revealReply: Awaited<ReturnType<typeof dispatcher.dispatch>> | undefined
    const target = { sessionId: HOST_TEST_SESSION, worktreeId: HOST_TEST_LOCATION.workspaceId }
    const guard = {
      botId: 'bot',
      conversation,
      leadSessionId: HOST_TEST_SESSION,
      ...target,
      itemId: 'question-A'
    }
    const opening = openStructuredAgentSession(
      { kind: 'notification', ...target },
      {
        current: () => true,
        locate: async () => ({ location: { kind: 'chat', ...target } }),
        refresh: async () => {},
        tabs: () => {
          const id = store.getSessionTabId(HOST_TEST_SESSION)
          return id ? [{ id, sessionId: HOST_TEST_SESSION, agent: 'codex' }] : []
        },
        activate: async (tab) => {
          const reply = await dispatcher.dispatch(
            {
              id: 'activate',
              authToken: 'token',
              method: 'session.tabs.activate',
              params: {
                worktree: WORKTREE,
                tabId: tab.id,
                navigation: 'caller',
                botLinkTarget: guard
              }
            },
            phone
          )
          if (!reply.ok) {
            throw Object.assign(new Error('Activation refused'), reply.error)
          }
          return true
        },
        reveal: async () => {
          revealReply = await dispatcher.dispatch(
            {
              id: 'reveal',
              authToken: 'token',
              method: 'agentSession.reveal',
              params: {
                sessionId: HOST_TEST_SESSION,
                navigation: 'caller',
                botLinkTarget: guard
              }
            },
            phone
          )
          if (!revealReply.ok) {
            return structuredSessionOpenFailure(revealReply.error)
          }
          const result = revealReply.result
          if (
            result &&
            typeof result === 'object' &&
            'ok' in result &&
            result.ok === false &&
            'refusal' in result
          ) {
            return structuredSessionOpenFailure(result.refusal)
          }
          expect(result).toMatchObject({ ok: true, sessionId: HOST_TEST_SESSION })
          return target
        }
      }
    )
    if (mode !== 'control') {
      await entered.promise
      expect(store.getSessionTabId(HOST_TEST_SESSION)).not.toBeNull()
      expect(
        (await host.deps.journalDatabase.loadRecords()).sessionTabs?.tabIdFor(HOST_TEST_SESSION)
      ).toBeDefined()
      writeLink(conversations.store, workspace, {
        ...link,
        sessionId: 'session-other',
        paneKey: 'chat:session-other'
      })
      release.resolve()
    }
    const result = await opening
    if (mode === 'control') {
      expect(result.kind).toBe('opened')
      expect(revealReply).toMatchObject({
        ok: true,
        result: { ok: true, sessionId: HOST_TEST_SESSION }
      })
    } else {
      expect(revealReply).toMatchObject({
        ok: true,
        result: { ok: false, refusal: { code: 'agent_session_operation_unknown' } }
      })
      expect(result).toMatchObject({
        kind: 'failed',
        failure: { reason: 'unreachable', beforeEffects: false }
      })
      expect(store.getSessionTabId(HOST_TEST_SESSION)).not.toBeNull()
      expect(
        (await host.deps.journalDatabase.loadRecords()).sessionTabs?.tabIdFor(HOST_TEST_SESSION)
      ).toBeDefined()
      expect(
        (await runtime.listMobileSessionTabs(WORKTREE, phone.pairedDeviceId)).activeTabId
      ).toBe(before.activeTabId)
    }
  }
)
