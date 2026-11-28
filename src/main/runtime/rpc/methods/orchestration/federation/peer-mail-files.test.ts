// `send --on <server> --to bot:<name> --file`, through the real send and delivery on both Orcas;
// only the attachment transfer between them is stubbed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_PEER_MAIL_CHAT_FILES_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { BotItemsRemote } from '../../../../../bots/bot-items-ops'
import { botChat, runningTurnReads } from './sending-bot-turn.test-fixture'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { AgentSessionAttachmentStore } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { agentSessionAttachmentStoreRoot } from '../../../../../native-chat/agent-session-attachments/agent-session-attachment-references'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/federation/environment-transport'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcContext } from '../../../core'
import { ORCHESTRATION_METHODS } from '../orchestration'

const CHAT_ON_A = 'orca_session_id:11111111-1111-4111-8111-111111111111'
const CHAT_ON_B = 'orca_session_id:22222222-2222-4222-8222-222222222222'
const B_SESSION = CHAT_ON_B.slice('orca_session_id:'.length)
const A_SESSION = CHAT_ON_A.slice('orca_session_id:'.length)
const OWNER_OPENER = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'send Docs the notes' }],
  typedBy: { by: 'host' }
}

type Side = { db: OrchestrationDb; runtime: OrcaRuntimeService; dispatcher: RpcDispatcher }

describe('files sent with mail to a bot on a paired server', () => {
  let dir: string
  let a: Side
  let b: Side
  let bCapabilities: (capabilities: string[]) => string[]
  let bStore: AgentSessionAttachmentStore
  let calls: { method: string; params: unknown }[]
  let claimedFor: string[]
  let file: string

  function openSide(name: string, machine: string, transport?: OrchestrationEnvironmentTransport) {
    const db = new OrchestrationDb(join(dir, `${name}.db`))
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    vi.spyOn(runtime, 'readMachineName').mockReturnValue(machine)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
    runtime.setOrchestrationDb(db)
    return {
      db,
      runtime,
      dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    }
  }

  /** The transfer itself, stubbed: bytes land in B's real store, as its upload methods put them. */
  const uploads = new Map<string, { name: string; chunks: Buffer[] }>()
  async function transfer(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'agentSessionAttachment.uploadStart') {
      const uploadId = `upload_${uploads.size + 1}`
      uploads.set(uploadId, { name: String(params.name), chunks: [] })
      return { uploadId }
    }
    const upload = uploads.get(String(params.uploadId))!
    if (method === 'agentSessionAttachment.uploadAppend') {
      upload.chunks.push(Buffer.from(String(params.contentBase64), 'base64'))
      return { receivedBytes: Buffer.concat(upload.chunks).byteLength }
    }
    const bytes = Buffer.concat(upload.chunks)
    const path = await bStore.storeFile(upload.name, bytes)
    return { path, name: upload.name, byteLength: bytes.byteLength }
  }

  const reply = (id: string, result: unknown): RuntimeRpcResponse<unknown> => ({
    id,
    ok: true,
    result,
    _meta: { runtimeId: b.runtime.getRuntimeId() }
  })

  const transport: OrchestrationEnvironmentTransport = {
    resolve: () => ({
      environmentId: 'env_b',
      name: 'devB',
      peerFingerprint: 'fingerprint_b',
      homePeerFingerprint: 'fingerprint_a'
    }),
    hasEnvironment: () => true,
    call: async (_selector, method, params) => {
      calls.push({ method, params })
      if (method === 'status.get') {
        const status = b.runtime.getStatus()
        return {
          id: 'status',
          ok: true,
          result: { ...status, capabilities: bCapabilities(status.capabilities ?? []) },
          _meta: { runtimeId: b.runtime.getRuntimeId() }
        }
      }
      if (method.startsWith('agentSessionAttachment.')) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every upload call carries an object of params.
        return reply(method, await transfer(method, params as Record<string, unknown>))
      }
      if (method === 'bots.items.owner.show') {
        return reply(method, { item: { chat: { id: B_SESSION } } })
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
      return (await b.dispatcher.dispatch(
        {
          id: `from_a_${method}`,
          authToken: 'a-device-token',
          method,
          params,
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
        },
        {
          authenticatedCallerFingerprint: 'fingerprint_a',
          pairedDeviceId: 'device_a',
          clientKind: 'runtime'
        }
      )) as RuntimeRpcResponse<unknown>
    }
  }

  /** Bot Docs on B, whose Home Chat is CHAT_ON_B; bot Scout on A sends from CHAT_ON_A. */
  function bots(): void {
    const { bot, record } = botChat('Docs', B_SESSION)
    const sender = botChat('Scout', A_SESSION)
    const host = {
      deps: {
        store: {
          getConversation: (id: string) =>
            id === B_SESSION ? record : id === A_SESSION ? sender.record : null,
          listConversations: () => [record]
        }
      },
      journalReads: runningTurnReads(OWNER_OPENER),
      conversation: async () => ({
        journal: { queuedMessages: { failureHolds: async () => false } }
      }),
      captureAgentStartDestination: async (id: string) => id,
      appendAgentStart: async () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the native host calls Home admission uses.
    setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
    vi.spyOn(b.runtime.bots, 'list').mockReturnValue([bot])
    vi.spyOn(b.runtime.bots, 'enabled').mockReturnValue(true)
    vi.spyOn(b.runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    vi.spyOn(b.runtime, 'publishStructuredAgentSessionTab').mockResolvedValue()
    vi.spyOn(b.runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(a.runtime.bots, 'list').mockReturnValue([sender.bot])
    vi.spyOn(a.runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    const item = { uid: 'item-7', number: 7, ownerBotId: bot.id, chatId: B_SESSION }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the item lookups mail about an item reads.
    const items = { byNumber: async () => item, get: async () => item } as unknown as BotItemsRemote
    vi.spyOn(b.runtime.botItems, 'store').mockReturnValue(items)
    vi.spyOn(b.runtime.botItems, 'owningChat').mockReturnValue({
      id: B_SESSION,
      kind: 'home',
      title: null
    })
  }

  function send(params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((entry) => entry.name === 'orchestration.send')!
    const context = {
      runtime: a.runtime,
      orchestrationCaller: {
        address: CHAT_ON_A,
        terminalHandle: null,
        orcaSessionId: A_SESSION,
        sessionId: A_SESSION,
        paneKey: null
      }
    }
    return method.handler(
      { from: CHAT_ON_A, on: 'devB', subject: 'Notes', type: 'question', ...params },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
      context as unknown as RpcContext
    )
  }

  const methods = () => calls.map(({ method }) => method)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-peer-mail-files-'))
    bCapabilities = (capabilities) => capabilities
    calls = []
    claimedFor = []
    uploads.clear()
    b = openSide('b', 'Build Box')
    a = openSide('a', "Jinwoo's Mac", transport)
    bStore = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(join(dir, 'b')), {
      hasSession: () => true
    })
    setAgentSessionAttachmentStore(bStore, async (sessionId) => {
      claimedFor.push(sessionId)
    })
    file = join(dir, 'notes.txt')
    writeFileSync(file, 'the notes')
    bots()
  })

  afterEach(() => {
    setStructuredAgentSessionHost(null)
    setAgentSessionAttachmentStore(null)
    a.runtime.stopOrchestrationFederationRelay()
    b.runtime.stopOrchestrationFederationRelay()
    a.db.close()
    b.db.close()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('attaches the files without --item, into the Home Chat the mail lands in', async () => {
    await send({ to: 'bot:Docs', body: 'Here they are.', files: [file] })

    expect(calls.find(({ method }) => method === 'agentSessionAttachment.uploadStart')).toEqual({
      method: 'agentSessionAttachment.uploadStart',
      params: { bot: 'Docs', name: 'notes.txt', byteLength: 9 }
    })
    expect(methods()).not.toContain('bots.items.owner.show')
    const [message] = b.db.getUnreadMessages(CHAT_ON_B)
    const stored = message!.body.split('\n').at(-1)!
    expect(message!.body.startsWith('Here they are.\n\n')).toBe(true)
    expect(stored).toContain(bStore.rootDir)
    expect(stored).toContain('notes.txt')
    expect(claimedFor).toEqual([B_SESSION])
  })

  it('attaches them into the --chat the mail names', async () => {
    await send({ to: 'bot:Docs', chat: `chat:${B_SESSION}`, files: [file] })

    const [message] = b.db.getUnreadMessages(CHAT_ON_B)
    expect(message!.body).toContain('notes.txt')
    expect(claimedFor).toEqual([B_SESSION])
  })

  it('keeps --item uploading into the item chat', async () => {
    await send({ to: 'bot:Docs', item: '7', files: [file] })

    expect(calls.find(({ method }) => method === 'agentSessionAttachment.uploadStart')).toEqual({
      method: 'agentSessionAttachment.uploadStart',
      params: { sessionId: B_SESSION, name: 'notes.txt', byteLength: 9 }
    })
    expect(methods()).toContain('bots.items.owner.show')
    const delivered = calls.find(({ method }) => method === 'orchestration.peerMailDeliver')
    expect(delivered?.params).toMatchObject({ item: '7', attachments: [expect.any(String)] })
    expect(b.db.getUnreadMessages(CHAT_ON_B)[0]!.body).toContain('notes.txt')
    expect(claimedFor).toEqual([B_SESSION])
  })

  it.each([
    ['an agent that is no bot', { to: 'term_b' }, '--file with --on goes to a bot there'],
    [
      'a bot chat by its session address',
      { to: CHAT_ON_B },
      '--file with --on goes to a bot there'
    ],
    ['a new chat', { to: 'bot:Docs', chat: 'new' }, 'drop --chat new']
  ])('refuses files to %s before asking the server anything', async (_name, to, message) => {
    await expect(send({ ...to, files: [file] })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining(message),
      data: { effectsApplied: false }
    })
    expect(calls).toEqual([])
    expect(b.db.getInbox(10)).toEqual([])
  })

  it('refuses files without --item to an Orca that only takes them with one, uploading nothing', async () => {
    bCapabilities = (capabilities) =>
      capabilities.filter(
        (capability) => capability !== ORCHESTRATION_PEER_MAIL_CHAT_FILES_RUNTIME_CAPABILITY
      )

    await expect(send({ to: 'bot:Docs', files: [file] })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: "devB's Orca needs an update to receive files without --item. Nothing was sent.",
      data: { effectsApplied: false }
    })
    expect(methods()).toEqual(['status.get'])
    expect(b.db.getInbox(10)).toEqual([])
  })
})
