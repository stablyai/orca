import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { createQueuedMessageTestRig } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_LOCATION } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeBotConversations } from '../bots/bot-conversations'
import { deliveryChatId } from './external-conversation-bots'
import { recoverConnectorAdmission } from './external-conversation-delivery-preparation'
import { DeliveryPreparation, DeliveryReceipts } from './external-conversation-delivery-receipts'
import { ExternalConversationSeam } from './external-conversation-seam'
import { SlackMirror } from './slack-mirror'
import type { ExternalConversationLinkStore } from './external-conversation-links'
import { startConnectorConversation } from './external-conversation-start'
import { runtimeChatHost } from './external-conversation-chat'
import type { Delivery } from './external-conversation-types'

const KEY = { source: 'slack' as const, externalId: 'T1:C1:1.2:UBOT' }
const ID = 'delivery'
const TARGET = { kind: 'bot' as const, botId: 'bot-1' }
const INPUT = { agent: 'codex', target: TARGET, prompt: 'request' }
const HOME_ID = 'fixture-home'
const TITLE = 'Look at <https://example.invalid|literal-label> in the image'

it('reuses the persisted agent and workspace when a thread start is retried', async () => {
  const sessionId = deliveryChatId(KEY, TARGET, ID)
  const worktreeId = folderWorkspaceKey(HOME_ID)
  const rig = await createQueuedMessageTestRig({
    sessionId,
    location: { ...HOST_TEST_LOCATION, workspaceId: worktreeId, workspaceKind: 'folder' }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the existing thread uses the installed test host and bot list.
  const runtime = {
    bots: { list: () => [{ id: TARGET.botId, folderWorkspaceId: 'new-home', agent: 'pi' }] },
    ensureStructuredAgentSessionHost: async () => setStructuredAgentSessionHost(rig.host)
  } as unknown as OrcaRuntimeService
  try {
    const botChats = runtimeBotConversations(runtime)
    await expect(
      botChats.open(TARGET, { sessionId, signal: new AbortController().signal })
    ).resolves.toEqual({ sessionId, worktreeId, agent: 'codex' })
  } finally {
    setStructuredAgentSessionHost(null)
    await rig.dispose()
  }
})

it.each(['accepted', 'unknown', 'rejected'] as const)(
  'recovers a %s admission that was interrupted before writing the thread link',
  async (outcome) => {
    const sessionId = deliveryChatId(KEY, TARGET, ID)
    const workspaceId = folderWorkspaceKey(HOME_ID)
    const rig = await createQueuedMessageTestRig({
      sessionId,
      starting: true,
      location: { ...HOST_TEST_LOCATION, workspaceId, workspaceKind: 'folder' }
    })
    const path = join(rig.root, 'connector-receipts.sqlite')
    let db = new OrchestrationDb(path)
    const preparation = new DeliveryPreparation()
    const before = new DeliveryReceipts(() => db)
    const pending = () => new Promise<Delivery>(() => {})
    void before.run(
      KEY,
      ID,
      'connector.start',
      [INPUT.agent, TARGET, INPUT.prompt],
      pending,
      preparation
    )
    try {
      const send = rig.send(INPUT.prompt, undefined, { internal: true })
      if (outcome === 'unknown') {
        preparation.restoreThreadOnRestart({
          ...KEY,
          botId: TARGET.botId,
          title: TITLE,
          asker: {
            role: 'owner',
            name: 'Fixture Owner',
            place: { kind: 'public_channel', id: 'C1' }
          }
        })
      }
      preparation.attempting(sessionId, send.id)
      await expect(send.result).resolves.toMatchObject({ ok: true })
      if (outcome === 'rejected') {
        const { journal } = await rig.host.conversation(sessionId)
        await journal.settleStartFailure({
          startKey: send.id,
          clientMessageId: send.id,
          fence: rig.store.getRecord(sessionId)!.lease.runtimeFence,
          ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
            surface: 'rejection'
          })
        })
      } else if (outcome === 'unknown') {
        const { journal } = await rig.host.conversation(sessionId)
        await journal.resolveDispatch({
          clientMessageId: send.id,
          fence: rig.store.getRecord(sessionId)!.lease.runtimeFence,
          state: 'unknown',
          reason: 'fixture writer did not settle'
        })
      }
      db.close()
      db = new OrchestrationDb(path)

      const folder: { id: string; externalConversations: ExternalConversationLink[] } = {
        id: HOME_ID,
        externalConversations: []
      }
      const runtime = {
        host: rig.host,
        async ensureStructuredAgentSessionHost() {
          setStructuredAgentSessionHost(this.host)
        }
      }
      const receipts: DeliveryReceipts = new DeliveryReceipts(
        () => db,
        (attempt) =>
          recoverConnectorAdmission(attempt, runtime, (key, chat) => {
            if (!seam.linkedChat(key)) {
              seam.linkChat(key, chat, { title: key.title }, key.asker)
            }
          })
      )
      const store: ExternalConversationLinkStore = {
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        setWorktreeMeta: () => {},
        getRepos: () => [],
        getFolderWorkspaces: () => [folder],
        getFolderWorkspace: () => folder,
        updateFolderWorkspace: (_, { externalConversations }) => {
          folder.externalConversations = externalConversations
        }
      }
      const mirror = new SlackMirror({
        store,
        cloud: () => null,
        orcaName: () => 'Fixture Owner',
        botSetting: () => undefined,
        readMessage: async () => null,
        emitTurnEnd: () => false,
        signal: new AbortController().signal
      })
      const seam = new ExternalConversationSeam({
        store,
        slackMirror: () => mirror,
        receipts,
        onWorkspaceRemoved: () => () => {},
        onAgentPaneChange: () => () => {},
        readHookRow: () => null
      })
      const host = {
        chat: runtimeChatHost(runtime),
        bots: {
          refusal: () => null,
          open: async () => {
            throw new Error('the existing thread must keep its chat')
          },
          workLinks: async () => []
        }
      }
      if (outcome === 'unknown') {
        // The lease expired during restart. The next message must restore the thread without a resend.
        await expect(seam.send(host, KEY, 'follow-up', { text: 'next' })).resolves.toEqual({
          outcome: 'accepted'
        })
        await expect(receipts.recorded(KEY, ID)).resolves.toMatchObject({ outcome: 'unknown' })
        expect(seam.linkedChat(KEY)).toEqual({ sessionId, worktreeId: workspaceId })
        expect(folder.externalConversations[0]).toMatchObject({
          title: TITLE,
          opener: { role: 'owner', name: 'Fixture Owner' },
          mirror: true
        })
        const history = await rig.host.history({ sessionId, direction: 'tail' })
        if (!history.ok) {
          throw new Error('could not read the recovered thread')
        }
        expect(history.page.queuedMessages).toHaveLength(1)
        expect(history.page.queuedMessages?.[0]).toMatchObject({
          state: 'waiting',
          body: { connectorConversation: KEY, blocks: [{ type: 'text', text: 'next' }] }
        })
      } else {
        const recovered = await seam.start(host, KEY, ID, INPUT, new DeliveryPreparation())
        expect(recovered.initial.outcome).toBe(outcome === 'rejected' ? 'refused' : 'accepted')
      }
      if (outcome === 'accepted') {
        expect(seam.linkedChat(KEY)).toEqual({ sessionId, worktreeId: workspaceId })
        expect(folder.externalConversations).toMatchObject([{ sessionId, agent: 'codex' }])
      } else if (outcome === 'rejected') {
        expect(seam.linkedChat(KEY)).toBeNull()
        await expect(receipts.recorded(KEY, ID)).resolves.toMatchObject({
          outcome: 'refused',
          reason: 'agent_not_reachable',
          failure: { category: 'signed_out' }
        })
      }
      expect(await (await rig.host.journalReads(sessionId)).sendFingerprints()).toHaveLength(1)
      seam.dispose('connectors_disabled')
    } finally {
      setStructuredAgentSessionHost(null)
      db.close()
      await rig.dispose()
    }
  }
)

it('cleans up an unused thread when its poll retires without a resend', async () => {
  const db = new OrchestrationDb(':memory:')
  const forget = vi.fn(async () => {})
  const poll = new AbortController()
  const retiredPoll = new DeliveryPreparation(poll.signal, () => 30_000)
  const signal = new AbortController().signal
  const deliver = vi.fn(async (): Promise<Delivery> => {
    poll.abort()
    return { outcome: 'refused', reason: 'connectors_disabled' }
  })
  const deps = {
    store: {
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => {},
      getRepos: () => []
    },
    receipts: new DeliveryReceipts(() => db),
    enqueue: (run: (signal: AbortSignal) => Promise<Delivery>) => run(signal),
    deliver,
    link: () => {}
  }
  const host = {
    bots: {
      refusal: () => null,
      open: async () => ({
        sessionId: deliveryChatId(KEY, TARGET, ID),
        agent: 'codex' as const,
        worktreeId: folderWorkspaceKey(HOME_ID)
      }),
      workLinks: async () => [],
      forgetUnusedStart: forget
    }
  }
  try {
    const retired = await startConnectorConversation(deps, host, KEY, ID, INPUT, retiredPoll)
    expect(retired.initial.outcome).toBe('refused')
    expect(forget).toHaveBeenCalledExactlyOnceWith(deliveryChatId(KEY, TARGET, ID))
    forget.mockClear()
    const expired = await startConnectorConversation(
      deps,
      host,
      KEY,
      ID,
      INPUT,
      new DeliveryPreparation(undefined, () => 0)
    )
    expect(expired.initial).toEqual({ outcome: 'expired' })
    expect(forget).toHaveBeenCalledExactlyOnceWith(deliveryChatId(KEY, TARGET, ID))
    expect(deliver).toHaveBeenCalledTimes(1)
  } finally {
    db.close()
  }
})
