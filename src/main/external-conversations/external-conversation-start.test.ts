import { join } from 'node:path'
import { expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { createQueuedMessageTestRig } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_LOCATION } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { deliveryChatId } from './external-conversation-bots'
import { recoverConnectorAdmission } from './external-conversation-delivery-preparation'
import { DeliveryPreparation, DeliveryReceipts } from './external-conversation-delivery-receipts'
import { ExternalConversationSeam } from './external-conversation-seam'
import { runtimeChatHost } from './external-conversation-chat'
import type { Delivery } from './external-conversation-types'

const KEY = { source: 'slack' as const, externalId: 'T1:C1:1.2:UBOT' }
const ID = 'delivery'
const TARGET = { kind: 'bot' as const, botId: 'bot-1' }
const INPUT = { agent: 'codex', target: TARGET, prompt: 'request' }
const HOME_ID = 'fixture-home'

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
        preparation.restoreThreadOnRestart({ ...KEY, botId: TARGET.botId, title: INPUT.prompt })
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
      const receipts: DeliveryReceipts = new DeliveryReceipts(
        () => db,
        (attempt) =>
          recoverConnectorAdmission(attempt, undefined, (key, chat) => {
            if (!seam.linkedChat(key)) {
              seam.linkChat(key, chat, key.title)
            }
          })
      )
      const seam = new ExternalConversationSeam({
        store: {
          getAllWorktreeMeta: () => ({}),
          getWorktreeMeta: () => undefined,
          setWorktreeMeta: () => {},
          getRepos: () => [],
          getFolderWorkspaces: () => [folder],
          getFolderWorkspace: () => folder,
          updateFolderWorkspace: (_, { externalConversations }) => {
            folder.externalConversations = externalConversations
          }
        },
        receipts,
        onWorkspaceRemoved: () => () => {},
        onAgentPaneChange: () => () => {},
        readHookRow: () => null
      })
      setStructuredAgentSessionHost(rig.host)
      const host = { chat: runtimeChatHost({ ensureStructuredAgentSessionHost: async () => {} }) }
      if (outcome === 'unknown') {
        // The lease expired during the restart and the cloud never resends the start.
        await expect(receipts.recorded(KEY, ID)).resolves.toMatchObject({ outcome: 'unknown' })
        expect(seam.linkedChat(KEY)).toEqual({ sessionId, worktreeId: workspaceId })
      }
      const recovered = await seam.start(host, KEY, ID, INPUT, new DeliveryPreparation())
      if (outcome === 'accepted') {
        expect(recovered.initial).toEqual({ outcome: 'accepted' })
        expect(seam.linkedChat(KEY)).toEqual({ sessionId, worktreeId: workspaceId })
        expect(folder.externalConversations).toMatchObject([{ sessionId, agent: 'codex' }])
      } else if (outcome === 'rejected') {
        expect(recovered.initial).toMatchObject({
          outcome: 'refused',
          reason: 'agent_not_reachable',
          failure: { category: 'signed_out' }
        })
        expect(seam.linkedChat(KEY)).toBeNull()
        await expect(receipts.recorded(KEY, ID)).resolves.toMatchObject({ outcome: 'refused' })
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
