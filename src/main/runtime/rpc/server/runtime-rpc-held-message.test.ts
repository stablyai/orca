// A teammate's held message runs through the real dispatcher as their share device: the share
// allowlist, chat guard and structured-session gates admit it, and it reaches the chat's send. A
// held new chat and a live New chat naming the same id open one chat, whichever comes first.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import nacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Bot } from '../../../../shared/bot-types'
import {
  sealBotTeamShareHeldMessage,
  type BotTeamShareHeldMessage
} from '../../../../shared/bots/bot-team-share-seal'
import { NODE_PAIRED_E2EE_PRIMITIVES } from '../../../../shared/remote-runtime/e2ee/node/paired-e2ee-node-primitives'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { BotShareDevice } from './pairing/bot-share-device-store'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type * as ChatSession from '../../../bots/bot-chat-session'
import type * as ChatTreeHost from '../../../bots/bot-chat-tree-host'

// Making a chat needs a real agent: stood in for, recording whom it acts for as the real one does.
const started = vi.hoisted(() => ({ count: 0 }))
vi.mock('../../../bots/bot-chat-session', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatSession>()),
  startBotSession: vi.fn(
    async (runtime: OrcaRuntimeService, _bot: Bot, input: { actsFor: { actsFor: [] } }) => {
      const id = chatId(++started.count)
      runtime.getOrchestrationDb().recordBotConversationActsFor(id, input.actsFor)
      return id
    }
  )
}))
vi.mock('../../../bots/bot-chat-tree-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatTreeHost>()),
  openEmptyBotChat: vi.fn(async () => null)
}))

function chatId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}
const OWN_CHAT = chatId(100)
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const person = (userId: string) => ({
  kind: 'person' as const,
  source: 'orca' as const,
  userId,
  workspaceId: null,
  role: 'member' as const
})
const share = (accountId: string, name: string) => ({
  kind: 'account',
  shareId: `share-${accountId}`,
  accountId,
  name,
  email: `${name.toLowerCase()}@example.com`,
  addedAt: 1
})

class HeldMessageServer extends OrcaRuntimeRpcServer {
  /** A live call from the device, as its socket would make it. */
  callAs(device: BotShareDevice, method: string, params: unknown): Promise<unknown> {
    return this.callAsBotShareDevice(device, method, params)
  }
}

let userDataPath: string
let db: OrchestrationDb
let server: HeldMessageServer
let sends: { envelope: { sessionId: string; clientOperationId: string } }[]
const devices: Record<string, { keys: nacl.SignKeyPair; row: BotShareDevice }> = {}

beforeEach(async () => {
  started.count = 0
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-held-dispatch-'))
  const runtime = new OrcaRuntimeService()
  db = new OrchestrationDb(join(userDataPath, 'orchestration.db'))
  vi.spyOn(runtime, 'getOrchestrationDb').mockReturnValue(db)
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  vi.spyOn(runtime.bots, 'assertEnabled').mockReturnValue(undefined)
  const bot = {
    id: 'bot-1',
    folderWorkspaceId: 'home-1',
    shares: [share('acct-alice', 'Alice'), share('acct-bob', 'Bob')]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the share checks, guard and start read only a bot's id, home folder and shares.
  vi.spyOn(runtime.bots, 'list').mockReturnValue([bot] as unknown as Bot[])
  db.recordBotConversationActsFor(OWN_CHAT, { actsFor: [person('acct-alice')] })
  sends = []
  setStructuredAgentSessionHost(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers this reaches read only these.
    {
      deps: {
        store: {
          listConversations: () => [],
          getConversation: () => ({
            location: { workspaceId: folderWorkspaceKey('home-1') },
            currentFence: 1
          })
        }
      },
      sessionAgent: () => 'claude',
      historyItem: async () => null,
      send: async (_caller: unknown, params: (typeof sends)[number]) => {
        sends.push(params)
        return {
          ok: true,
          value: { clientMessageId: params.envelope.clientOperationId, queued: {} }
        }
      }
    } as unknown as StructuredAgentSessionHost
  )
  server = new HeldMessageServer({ runtime, userDataPath, enableWebSocket: true, wsPort: 0 })
  await server.start()
  for (const [accountId, name] of [
    ['acct-alice', 'Alice'],
    ['acct-bob', 'Bob']
  ] as const) {
    const keys = nacl.sign.keyPair()
    const row = await server.getBotShareDevices()!.add({
      botId: 'bot-1',
      accountId,
      name,
      scope: 'runtime',
      devicePublicKeyB64: b64(keys.publicKey)
    })
    devices[accountId] = { keys, row }
  }
})

afterEach(async () => {
  await server.stop()
  setStructuredAgentSessionHost(null)
  db.close()
  rmSync(userDataPath, { recursive: true, force: true })
})

async function deliverHeld(
  accountId: string,
  chat: BotTeamShareHeldMessage['chat'],
  clientMessageId = 'msg-1'
) {
  const { keys } = devices[accountId]!
  const shareId = `share-${accountId}`
  const sealed = await sealBotTeamShareHeldMessage(NODE_PAIRED_E2EE_PRIMITIVES, {
    hostKey: server.getE2EEPublicKey()!,
    message: {
      v: 1,
      shareId,
      botId: 'bot-1',
      chat,
      clientMessageId,
      text: 'Can you check the build?',
      attachments: [],
      sentAt: 1,
      devicePublicKey: b64(keys.publicKey)
    },
    sign: async (bytes) => nacl.sign.detached(bytes, keys.secretKey)
  })
  return await server.deliverBotShareHeldMessage({
    kind: 'share_send',
    deliveryId: `d-${clientMessageId}`,
    expiresAt: 10,
    conversation: { source: 'orca', externalId: shareId },
    shareId,
    botId: 'bot-1',
    accountId,
    clientMessageId,
    sealed
  })
}

const Started = z.object({ sessionId: z.string() })
const liveStart = async (accountId: string, newChatId: string) =>
  Started.parse(
    await server.callAs(devices[accountId]!.row, 'bots.session.start', {
      botId: 'bot-1',
      newChatId
    })
  )

describe('a held message through the dispatcher', () => {
  it('reaches agentSession.send in the teammate’s own chat, as their share device', async () => {
    expect(await deliverHeld('acct-alice', { sessionId: OWN_CHAT })).toEqual({
      outcome: 'accepted'
    })
    expect(sends.map((send) => send.envelope)).toEqual([
      expect.objectContaining({ sessionId: OWN_CHAT, clientOperationId: 'msg-1' })
    ])
  })

  it('opens one chat when the held new chat lands before the live one', async () => {
    await deliverHeld('acct-alice', { newChatId: 'new-1' })
    const held = sends[0]!.envelope.sessionId
    expect((await liveStart('acct-alice', 'new-1')).sessionId).toBe(held)
    await deliverHeld('acct-alice', { newChatId: 'new-1' }, 'msg-2')
    expect(sends.map((send) => send.envelope.sessionId)).toEqual([held, held])
    expect(started.count).toBe(1)
  })

  it('opens one chat when the live new chat lands before the held one', async () => {
    const { sessionId } = await liveStart('acct-alice', 'new-1')
    expect(await deliverHeld('acct-alice', { newChatId: 'new-1' })).toEqual({
      outcome: 'accepted'
    })
    expect(sends.map((send) => send.envelope.sessionId)).toEqual([sessionId])
    expect(started.count).toBe(1)
  })

  it('never hands one teammate the chat another opened with the same new-chat id', async () => {
    const alices = (await liveStart('acct-alice', 'new-1')).sessionId
    const bobs = (await liveStart('acct-bob', 'new-1')).sessionId
    expect(bobs).not.toBe(alices)
    await deliverHeld('acct-bob', { newChatId: 'new-1' })
    expect(sends.map((send) => send.envelope.sessionId)).toEqual([bobs])
  })
})
