// `send --on <server> --to bot:<name> --file`, through the real send and delivery on both Orcas;
// only the attachment transfer between them is stubbed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_PEER_MAIL_CHAT_FILES_RUNTIME_CAPABILITY,
  ORCHESTRATION_PEER_MAIL_FILES_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { BotItemsRemote } from '../../../../../bots/bot-items-ops'
import { botChat, runningTurnReads } from './sending-bot-turn.test-fixture'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
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
import { runtimeBotChats } from '../../../../../bots/bot-chat-session'
import type { Bot } from '../../../../../../shared/bot-types'

const CHAT_ON_A = 'orca_session_id:11111111-1111-4111-8111-111111111111'
const CHAT_ON_B = 'orca_session_id:22222222-2222-4222-8222-222222222222'
const B_SESSION = CHAT_ON_B.slice('orca_session_id:'.length)
// Another chat of Docs on B, not its Home Chat.
const B_OTHER = '44444444-4444-4444-8444-444444444444'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64'
)
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
  /** The upload (1-based) whose transfer fails. */
  let failingUpload: number | null
  /** Runs inside each claim, as another change to the bot's chats would. */
  let duringClaim: (() => void) | undefined
  let chatClosed: boolean
  let docs: Bot

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
      if (method === 'agentSessionAttachment.uploadStart' && uploads.size + 1 === failingUpload) {
        return { id: method, ok: false, error: { code: 'upload_failed', message: 'Disk full' } }
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
    const other = agentSessionConversationView({
      ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: B_OTHER })),
      location: { ...record.location }
    })
    docs = bot
    const sender = botChat('Scout', A_SESSION)
    const host = {
      deps: {
        store: {
          getConversation: (id: string) =>
            ({
              [B_SESSION]: record,
              [B_OTHER]: chatClosed ? null : other,
              [A_SESSION]: sender.record
            })[id] ?? null,
          listConversations: () => [record, other]
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
    failingUpload = null
    duringClaim = undefined
    chatClosed = false
    uploads.clear()
    b = openSide('b', 'Build Box')
    a = openSide('a', "Jinwoo's Mac", transport)
    bStore = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(join(dir, 'b')), {
      hasSession: () => true
    })
    setAgentSessionAttachmentStore(bStore, async (sessionId) => {
      claimedFor.push(sessionId)
      duringClaim?.()
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

  it('attaches them into the --chat the mail names, not the Home Chat', async () => {
    await send({ to: 'bot:Docs', chat: `chat:${B_OTHER}`, files: [file] })

    expect(b.db.getUnreadMessages(CHAT_ON_B)).toEqual([])
    const [message] = b.db.getUnreadMessages(`orca_session_id:${B_OTHER}`)
    expect(message!.body).toContain('notes.txt')
    expect(claimedFor).toEqual([B_OTHER])
  })

  it('carries an image without --item as the chat image it lands as', async () => {
    const image = join(dir, 'shot.png')
    writeFileSync(image, PNG)

    await send({ to: 'bot:Docs', files: [image] })

    const [message] = b.db.getUnreadMessages(CHAT_ON_B)
    const { images } = JSON.parse(message!.payload!) as { images?: string[] }
    expect(images).toEqual([expect.stringContaining(bStore.rootDir)])
    expect(images![0]).toContain('shot.png')
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
    [
      'an agent that is no bot',
      { to: 'term_b' },
      '--file with --on works only when sending to a bot'
    ],
    [
      'a bot chat by its session address',
      { to: CHAT_ON_B },
      '--file with --on works only when sending to a bot'
    ],
    ['a new chat', { to: 'bot:Docs', chat: 'new' }, 'drop --chat new'],
    [
      'an item and a chat at once',
      { to: 'bot:Docs', item: '7', chat: `chat:${B_OTHER}` },
      '--item or --chat'
    ],
    [
      'mail no bot takes',
      { to: 'bot:Docs', type: 'dispatch' },
      '--type status, handoff or question'
    ]
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
  it('refuses files with --item to an Orca from before files, uploading nothing', async () => {
    bCapabilities = (capabilities) =>
      capabilities.filter(
        (capability) =>
          capability !== ORCHESTRATION_PEER_MAIL_FILES_RUNTIME_CAPABILITY &&
          capability !== ORCHESTRATION_PEER_MAIL_CHAT_FILES_RUNTIME_CAPABILITY
      )

    await expect(send({ to: 'bot:Docs', item: '7', files: [file] })).rejects.toMatchObject({
      message: "devB's Orca needs an update to receive files. Nothing was sent.",
      data: { effectsApplied: false }
    })
    expect(methods()).toEqual(['status.get'])
    expect(b.db.getInbox(10)).toEqual([])
  })

  it('claims the files under the Home Chat lock, so a new Home Chat waits until the mail is stored', async () => {
    let stored: number | undefined
    let reset: Promise<void> | undefined
    duringClaim = () => {
      reset = runtimeBotChats(b.runtime).withChat(docs.id, () => {
        stored = b.db.getUnreadMessages(CHAT_ON_B).length
      })
    }

    await send({ to: 'bot:Docs', files: [file] })
    await reset

    expect(claimedFor).toEqual([B_SESSION])
    expect(stored).toBe(1)
  })

  it('refuses mail whose named chat moved on while its files were claimed, storing nothing', async () => {
    duringClaim = () => {
      chatClosed = true
    }

    await expect(
      send({ to: 'bot:Docs', chat: `chat:${B_OTHER}`, files: [file] })
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Docs's chat moved on to a new session while the files were attached\. Send it again\. The message wasn't sent\. A file already copied to devB/
      ),
      data: { effectsApplied: true, unattachedUploads: 1 }
    })
    expect(b.db.getInbox(10)).toEqual([])
  })

  it('refuses a file that cannot be read before uploading any', async () => {
    await expect(
      send({ to: 'bot:Docs', files: [file, join(dir, 'missing.txt')] })
    ).rejects.toMatchObject({
      message: "missing.txt can't be read. Nothing was sent.",
      data: { effectsApplied: false }
    })
    expect(methods()).not.toContain('agentSessionAttachment.uploadStart')
    expect(b.db.getInbox(10)).toEqual([])
  })

  it('says which files reached the server when a later upload fails', async () => {
    failingUpload = 2
    const second = join(dir, 'more.txt')
    writeFileSync(second, 'more notes')

    await expect(send({ to: 'bot:Docs', files: [file, second] })).rejects.toMatchObject({
      message:
        "Disk full. The message wasn't sent. A file already copied to devB for it is attached to nothing there; Orca on devB clears unused uploads later.",
      data: { effectsApplied: true, unattachedUploads: 1 }
    })
    expect(methods()).not.toContain('orchestration.peerMailDeliver')
    expect(b.db.getInbox(10)).toEqual([])
  })

  it('says which files reached the server when it refuses the mail', async () => {
    await expect(
      send({ to: 'bot:Docs', chat: 'chat:33333333-3333-4333-8333-333333333333', files: [file] })
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Docs has no chat .* lists\. The message wasn't sent\. A file already copied to devB/
      ),
      data: { unattachedUploads: 1 }
    })
    expect(b.db.getInbox(10)).toEqual([])
  })
})
