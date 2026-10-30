import '../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { listResult } from '../ai-vault/structured-session-ownership.test-support'
import * as scanner from '../ai-vault/session-scanner-background'
import { resetAiVaultSessionListCacheForTests } from '../ai-vault/cached-session-list'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { AI_VAULT_METHODS } from '../runtime/rpc/methods/ai-vault'
import { structuredChatNamingDeps } from '../runtime/structured-chat-naming-runtime'
import { createStructuredChatNamingHandler } from './structured-chat-naming'
import { setStructuredAgentSessionHost } from './agent-session-wire/structured-agent-session-registry'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from './agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from './agent-session-wire/structured-agent-session-host-test-data'

it.each(['J', 'R', 'P', 'L', 'T', 'U', 'C'] as const)(
  'counts actual naming, ownership, tab and transport work as %s varies independently',
  async (population) => {
    for (const n of [10, 100]) {
      const sizes = { J: 10, R: 10, P: 10, L: 10, T: 10, U: 10, C: 10 }
      sizes[population] = n
      if (population === 'J') {
        sizes.R = 100
      }
      const { host, store, log } = hostTestState()
      await attach()
      setStructuredAgentSessionHost(host)
      const runtime = new OrcaRuntimeService()
      vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
      const source = Promise.withResolvers<string>()
      const naming = createStructuredChatNamingHandler({
        ...structuredChatNamingDeps(
          () => ({ getSettings: () => getDefaultSettings('/isolated') }),
          {
            resolveWorkspace: async () => ({ path: '/fixture', executionHostId: 'local' }),
            resolveNamingEnvironment: async () => ({}),
            getAgentEnvResolvers: () => undefined,
            workerTaskTitle: () => null,
            retitleOpenTab: runtime.refreshStructuredConversationTabTitle.bind(runtime)
          },
          log.logger
        ),
        readJournalFirstPrompt: () => source.promise
      })
      host.deps.conversationNaming = naming
      let recordVisits = 0,
        linkVisits = 0,
        rowVisits = 0,
        labelVisits = 0
      const id = (index: number) =>
        index < 0 ? 'unrelated' : index ? `population-${index}` : HOST_TEST_SESSION
      const get = store.getRecord
      const getConversation = store.getConversation
      const providerId = (sessionId: string) =>
        sessionId === HOST_TEST_SESSION ? HOST_TEST_THREAD : `renderer-provider-${sessionId}`
      const records = Array.from({ length: sizes.R }, (_, index) => ({
        ...agentSessionRecordFixture(),
        sessionId: id(index),
        provider: 'codex' as const,
        conversationName: 'Before',
        get providerHandleChain() {
          recordVisits++
          return Array.from({ length: index === 1 ? sizes.P : 1 }, (_, link) => ({
            ...agentSessionRecordFixture().providerHandleChain[0]!,
            get handle() {
              linkVisits++
              return codexProviderHandle(link ? `extra-provider-${link}` : providerId(id(index)))
            }
          }))
        }
      }))
      const byId = new Map(records.map((record) => [record.sessionId, record]))
      const conversations = records.map((record) => ({
        ...agentSessionConversationView(record),
        get providerHandleChain() {
          return record.providerHandleChain
        }
      }))
      const conversationsById = new Map(conversations.map((view) => [view.sessionId, view]))
      const lookup = vi
        .spyOn(store, 'getRecord')
        .mockImplementation((id) => get(id) ?? byId.get(id) ?? null)
      const conversationLookup = vi
        .spyOn(store, 'getConversation')
        .mockImplementation((id) => getConversation(id) ?? conversationsById.get(id) ?? null)
      const list = vi
        .spyOn(store, 'listConversations')
        .mockImplementation(() => [getConversation(HOST_TEST_SESSION)!, ...conversations.slice(1)])
      for (let index = 0; index < sizes.J; index++) {
        naming.regenerate(id(index))
      }
      const workspace = 'workspace-1'
      for (let index = 0; index < sizes.T; index++) {
        runtime.projectStructuredAgentSessionTab({
          activate: false,
          sessionId: id(index),
          workspaceId: workspace,
          agent: 'codex'
        })
      }
      const session = getDefaultWorkspaceSession()
      session.unifiedTabs = {
        [workspace]: Array.from({ length: sizes.U }, (_, index) => ({
          id: `saved-${index}`,
          contentType: 'agent-session' as const,
          label: 'Codex Chat',
          groupId: 'fixture-group',
          worktreeId: workspace,
          customLabel: null,
          color: null,
          sortOrder: index,
          createdAt: 0,
          get entityId() {
            labelVisits++
            return id(index - Math.max(sizes.U - sizes.T, 0))
          }
        }))
      }
      vi.spyOn(runtime, 'getWorkspaceSessionForWorktree').mockReturnValue(session)
      const row = listResult().sessions[0]!
      resetAiVaultSessionListCacheForTests()
      const scan = vi.spyOn(scanner, 'scanAiVaultSessionsInBackground').mockResolvedValue({
        ...listResult(),
        sessions: Array.from({ length: sizes.L }, () => ({
          ...row,
          get sessionId() {
            rowVisits++
            return HOST_TEST_THREAD
          }
        }))
      })
      const client = {
        clientKind: 'runtime' as const,
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }
      const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
      const rpc = () =>
        dispatcher.dispatch(
          {
            id: 'list',
            authToken: 'fixture',
            method: 'aiVault.listSessions',
            params: { executionHostId: 'runtime:paired-host' }
          },
          client
        )
      const deliveries: string[] = []
      const subscriptions = Array.from({ length: sizes.C }, (_, index) =>
        host.subscribeStatus({
          id: `consumer-${index}`,
          emit: (event) => deliveries.push(JSON.stringify(event))
        })
      )
      const tabs: string[] = []
      subscriptions.push(
        ...Array.from({ length: sizes.C }, () =>
          runtime.onMobileSessionTabsChanged((value) => tabs.push(JSON.stringify(value)))
        )
      )
      try {
        lookup.mockClear()
        conversationLookup.mockClear()
        list.mockClear()
        recordVisits = linkVisits = rowVisits = labelVisits = 0
        deliveries.length = 0
        host.publishConversationName(HOST_TEST_SESSION)
        const snapshots = deliveries.filter((event) => event.includes('namingActiveSessionIds'))
        expect(snapshots).toHaveLength(sizes.C)
        expect(JSON.parse(snapshots[0]!).namingActiveSessionIds).toHaveLength(sizes.J)
        expect(
          lookup.mock.calls.length + conversationLookup.mock.calls.length
        ).toBeGreaterThanOrEqual(sizes.J + 1)
        expect(lookup.mock.calls.length + conversationLookup.mock.calls.length).toBeLessThanOrEqual(
          sizes.J + 10
        )
        expect(list).not.toHaveBeenCalled()
        for (let index = 0; index < sizes.C; index++) {
          const response = JSON.parse(JSON.stringify(await rpc()))
          expect(response.ok).toBe(true)
          expect(response.result.sessions).toHaveLength(sizes.L)
          for (const session of response.result.sessions) {
            expect(session).toMatchObject({
              executionHostId: 'runtime:paired-host',
              structuredSession: { sessionId: HOST_TEST_SESSION, workspaceId: workspace }
            })
          }
        }
        expect(list).toHaveBeenCalledTimes(sizes.C)
        expect(recordVisits).toBe(2 * sizes.C * (sizes.R - 1))
        expect(linkVisits).toBe(sizes.C * (sizes.R - 1 + 2 * (sizes.P + sizes.R - 2)))
        expect(rowVisits).toBe(2 * sizes.L * sizes.C)
        expect(scan).toHaveBeenCalledOnce()
        await store.setConversationName(HOST_TEST_SESSION, `Before ${n}`)
        labelVisits = 0
        tabs.length = 0
        naming.publishName(workspace, HOST_TEST_SESSION)
        expect(tabs).toHaveLength(sizes.C)
        // Counts the inherited populated-label lookup; its owner must remove this amplification.
        const comparisons =
          Math.max(sizes.U - sizes.T, 0) +
          1 +
          Array.from({ length: sizes.T }, (_, index) =>
            Math.min(sizes.U, Math.max(sizes.U - sizes.T, 0) + index + 1)
          ).reduce((a, b) => a + b, 0)
        expect(labelVisits).toBe(comparisons)
        const command = {
          envelope: envelope('agentSession.conversationCommand', { command: 'clear' }),
          command: 'clear' as const
        }
        const publication = vi.spyOn(naming, 'publishName')
        expect(await host.conversationCommand(CALLER, command)).toMatchObject({ ok: true })
        expect(publication).toHaveBeenCalledOnce()
        const retired = await rpc()
        expect(retired).toMatchObject({ ok: true })
        expect(JSON.stringify(retired)).not.toContain(`"sessionId":"${HOST_TEST_SESSION}"`)
        expect(tabs.at(-1)).toContain('Codex Chat')
        await store.setConversationName(HOST_TEST_SESSION, 'Newer name')
        expect(await host.conversationCommand(CALLER, command)).toMatchObject({ ok: true })
        expect(publication).toHaveBeenCalledTimes(2)
        expect(get(HOST_TEST_SESSION)?.conversationName).toBe('Newer name')
        expect(tabs.at(-1)).toContain('Newer name')
        expect(
          await host.conversationCommand(CALLER, {
            ...command,
            envelope: {
              ...command.envelope,
              clientOperationId: crypto.randomUUID(),
              expectedRuntimeFence: 0
            }
          })
        ).toMatchObject({ ok: false })
        expect(publication).toHaveBeenCalledTimes(2)
      } finally {
        subscriptions.forEach((stop) => stop())
        source.resolve('')
        await vi.waitFor(() => expect(naming.activeSessionIds()).toEqual([]))
        vi.restoreAllMocks()
        resetAiVaultSessionListCacheForTests()
        setStructuredAgentSessionHost(null)
      }
    }
  }
)
