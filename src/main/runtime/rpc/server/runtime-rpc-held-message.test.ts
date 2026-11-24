// A teammate's held message runs through the real dispatcher as their share device: the share
// allowlist, chat guard and structured-session gates admit it, and it reaches the chat's send.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { sealBotTeamShareHeldMessage } from '../../../../shared/bots/bot-team-share-seal'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const CHAT = '00000000-0000-4000-8000-000000000001'
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

afterEach(() => {
  setStructuredAgentSessionHost(null)
})

describe('a held message through the dispatcher', () => {
  it('reaches agentSession.send in the teammate’s own chat, as their share device', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-held-dispatch-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(join(userDataPath, 'orchestration.db'))
    vi.spyOn(runtime, 'getOrchestrationDb').mockReturnValue(db)
    vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    const bot = {
      id: 'bot-1',
      folderWorkspaceId: 'home-1',
      shares: [
        {
          kind: 'account',
          shareId: 'share-alice',
          accountId: 'acct-alice',
          name: 'Alice',
          email: 'alice@example.com',
          addedAt: 1
        }
      ]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the share checks and guard read only a bot's id, home folder and shares.
    vi.spyOn(runtime.bots, 'list').mockReturnValue([bot] as unknown as Bot[])
    db.recordBotConversationActsFor(CHAT, {
      actsFor: [
        {
          kind: 'person',
          source: 'orca',
          userId: 'acct-alice',
          workspaceId: null,
          role: 'member'
        }
      ]
    })
    const sends: unknown[] = []
    setStructuredAgentSessionHost(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers this reaches read only these.
      {
        deps: {
          store: {
            listConversations: () => [],
            getConversation: (id: string) =>
              id === CHAT
                ? { location: { workspaceId: folderWorkspaceKey('home-1') }, currentFence: 1 }
                : null
          }
        },
        sessionAgent: () => 'claude',
        historyItem: async () => null,
        send: async (_caller: unknown, params: unknown) => {
          sends.push(params)
          return { ok: true, value: { clientMessageId: 'msg-1', queued: {} } }
        }
      } as unknown as StructuredAgentSessionHost
    )
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    try {
      const keys = nacl.sign.keyPair()
      await server.getBotShareDevices()!.add({
        botId: 'bot-1',
        accountId: 'acct-alice',
        name: 'Alice',
        scope: 'runtime',
        devicePublicKeyB64: b64(keys.publicKey)
      })
      const hostKey = server.getE2EEPublicKey()!
      const sealed = await sealBotTeamShareHeldMessage(NODE_PAIRED_E2EE_PRIMITIVES, {
        hostKey,
        message: {
          v: 1,
          shareId: 'share-alice',
          botId: 'bot-1',
          chat: { sessionId: CHAT },
          clientMessageId: 'msg-1',
          text: 'Can you check the build?',
          attachments: [],
          sentAt: 1,
          devicePublicKey: b64(keys.publicKey)
        },
        sign: async (bytes) => nacl.sign.detached(bytes, keys.secretKey)
      })
      const result = await server.deliverBotShareHeldMessage({
        kind: 'share_send',
        deliveryId: 'd-1',
        expiresAt: 10,
        conversation: { source: 'orca', externalId: 'share-alice' },
        shareId: 'share-alice',
        botId: 'bot-1',
        accountId: 'acct-alice',
        clientMessageId: 'msg-1',
        sealed
      })
      expect(result).toEqual({ outcome: 'accepted' })
      expect(sends).toEqual([
        expect.objectContaining({
          envelope: expect.objectContaining({ sessionId: CHAT, clientOperationId: 'msg-1' }),
          userSend: true
        })
      ])
    } finally {
      await server.stop()
      db.close()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
