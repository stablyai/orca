// `send --on <server> --to bot:<name> --file`, through the real send and delivery on both Orcas;
// only the attachment transfer between them is stubbed.
import { execFileSync } from 'node:child_process'
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
import { applyJournalWriterEffect } from '../../../../../native-chat/agent-session-journal/journal-writer-effects'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { agentSessionAttachmentUploadIdOfPath } from '../../../../../../shared/agent-session/agent-session-attachments'
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
  let bState: string
  let journal: ReturnType<typeof openTestJournalHostDatabase>
  /** The upload's claims on B, by chat; none means the sweep treats it as unused. */
  const claimsOn = (path: string): string[] =>
    journal.db
      .prepare('SELECT session_id FROM agent_session_attachment_claims WHERE upload_id = ?')
      .all(agentSessionAttachmentUploadIdOfPath(path) ?? '')
      .map((row) => String(row.session_id))
  /** The upload (1-based) whose commit stores the file and then loses its answer. */
  let lostCommit: number | null
  let releaseFails: boolean
  let deliveryTimesOut: boolean
  let claimClock = 1_000_000

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
  /** Where B stored each upload it committed, in order. */
  const committed: string[] = []
  async function transfer(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'agentSessionAttachment.uploadStart') {
      const uploadId = `upload_${uploads.size + 1}`
      uploads.set(uploadId, { name: String(params.name), chunks: [] })
      return { uploadId }
    }
    const upload = uploads.get(String(params.uploadId))!
    if (method === 'agentSessionAttachment.uploadAbort') {
      return {}
    }
    if (method === 'agentSessionAttachment.uploadAppend') {
      upload.chunks.push(Buffer.from(String(params.contentBase64), 'base64'))
      return { receivedBytes: Buffer.concat(upload.chunks).byteLength }
    }
    const bytes = Buffer.concat(upload.chunks)
    const path = await bStore.storeFile(upload.name, bytes)
    committed.push(path)
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
      if (method === 'orchestration.peerMailDeliver' && deliveryTimesOut) {
        return { id: method, ok: false, error: { code: 'runtime_timeout', message: 'Timed out' } }
      }
      if (method === 'agentSessionAttachment.uploadCommit' && uploads.size === lostCommit) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every upload call carries an object of params.
        await transfer(method, params as Record<string, unknown>)
        return { id: method, ok: false, error: { code: 'runtime_timeout', message: 'Timed out' } }
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
  /** Questions A still waits on an answer for. */
  const questionsOut = () =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: COUNT(*) AS n always returns one row with a number.
    (a.db.db.prepare('SELECT COUNT(*) AS n FROM peer_questions_out').get() as { n: number }).n

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-peer-mail-files-'))
    bCapabilities = (capabilities) => capabilities
    calls = []
    claimedFor = []
    failingUpload = null
    lostCommit = null
    releaseFails = false
    deliveryTimesOut = false
    duringClaim = undefined
    chatClosed = false
    uploads.clear()
    committed.length = 0
    b = openSide('b', 'Build Box')
    a = openSide('a', "Jinwoo's Mac", transport)
    bState = join(dir, 'b')
    bStore = new AgentSessionAttachmentStore(agentSessionAttachmentStoreRoot(bState), {
      hasSession: () => true
    })
    // B's real claims: the journal's own claim and release, as the host installs them.
    journal = openTestJournalHostDatabase(bState)
    setAgentSessionAttachmentStore(
      bStore,
      async (sessionId, body) => {
        claimedFor.push(sessionId)
        // A fixed clock: each claim its own moment, as the release tells them apart.
        const now = (claimClock += 1)
        const claim = { sessionId, body, required: true, now }
        const claimed = applyJournalWriterEffect(journal.db, bState, { kind: 'claim', claim })
        duringClaim?.()
        return claimed && typeof claimed === 'object' && 'inserted' in claimed
          ? { uploadIds: claimed.inserted, claimedAt: now }
          : undefined
      },
      async (sessionId, { uploadIds, claimedAt }) => {
        if (releaseFails) {
          throw new Error('journal is read-only')
        }
        const release = { kind: 'release' as const, sessionId, uploadIds, claimedAt }
        applyJournalWriterEffect(journal.db, bState, release)
      }
    )
    file = join(dir, 'notes.txt')
    writeFileSync(file, 'the notes')
    bots()
  })

  afterEach(async () => {
    await closeTestJournalHostDatabase(bState)
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
    expect(claimsOn(committed[0]!)).toEqual([B_SESSION])
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a bot request's payload is the JSON botRequestPayload writes, whose images are store paths.
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
      '--file only works with --type status, handoff or question'
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
        /^Docs's chat moved on to a new session while uploading\. The message wasn't sent\. A file already copied to devB for it is attached to nothing there; Orca on devB clears unused uploads later\. Send it again\.$/
      ),
      code: 'peer_mail_not_sent',
      data: {
        cause: 'bot_chat_changed',
        retryable: true,
        effectsApplied: true,
        unattachedUploads: 1
      }
    })
    expect(b.db.getInbox(10)).toEqual([])
    // The claim it took was given back, so the sweep treats the file as unused.
    expect(claimedFor).toEqual([B_OTHER])
    expect(claimsOn(committed[0]!)).toEqual([])
    // Surely refused there, so A no longer waits for its answer.
    expect(questionsOut()).toBe(0)
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
  it('says a file may have been copied when its commit answer is lost', async () => {
    lostCommit = 1

    const error = await send({ to: 'bot:Docs', files: [file] }).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({
      message:
        "Timed out. The message wasn't sent. A file may have been copied to devB for it; if so, it is attached to nothing there, and Orca on devB clears unused uploads later.",
      data: { unattachedUploads: 0, maybeUploadedOneMore: true }
    })
    expect(error).not.toHaveProperty('data.effectsApplied')
    expect(committed).toHaveLength(1)
    expect(b.db.getInbox(10)).toEqual([])
  })

  it('counts the files it knows were copied, and the one that may have been', async () => {
    lostCommit = 2
    const second = join(dir, 'more.txt')
    writeFileSync(second, 'more notes')

    await expect(send({ to: 'bot:Docs', files: [file, second] })).rejects.toMatchObject({
      message:
        "Timed out. The message wasn't sent. A file already copied to devB for it, and maybe one more, are attached to nothing there; Orca on devB clears unused uploads later.",
      data: { effectsApplied: true, unattachedUploads: 1, maybeUploadedOneMore: true }
    })
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a pipe without waiting for a writer, uploading nothing',
    async () => {
      const pipe = join(dir, 'pipe')
      execFileSync('mkfifo', [pipe])

      await expect(send({ to: 'bot:Docs', files: [pipe] })).rejects.toMatchObject({
        message: "pipe can't be read. Nothing was sent.",
        data: { effectsApplied: false }
      })
      expect(methods()).not.toContain('agentSessionAttachment.uploadStart')
    }
  )

  it('says which files reached the server when a step before delivery fails', async () => {
    const prepare = a.db.db.prepare.bind(a.db.db)
    vi.spyOn(a.db.db, 'prepare').mockImplementation((sql: string) => {
      // The insert fails, and so would the cleanup of a row it never wrote.
      if (/(INSERT|DELETE)[^]*peer_questions_out/i.test(sql)) {
        throw new Error('disk I/O error')
      }
      return prepare(sql)
    })

    await expect(send({ to: 'bot:Docs', files: [file] })).rejects.toMatchObject({
      message:
        "disk I/O error. The message wasn't sent. A file already copied to devB for it is attached to nothing there; Orca on devB clears unused uploads later.",
      data: { effectsApplied: true, unattachedUploads: 1 }
    })
    expect(methods()).not.toContain('orchestration.peerMailDeliver')
  })
  it('says a chat may still hold the files when a refused send cannot give its claims back', async () => {
    releaseFails = true
    duringClaim = () => {
      chatClosed = true
    }

    await expect(
      send({ to: 'bot:Docs', chat: `chat:${B_OTHER}`, files: [file] })
    ).rejects.toMatchObject({
      code: 'peer_mail_not_sent',
      message:
        "Docs's chat moved on to a new session while uploading. The message wasn't sent. A file already copied to devB for it may still be kept there with a chat; if not, Orca on devB clears it as an unused upload later. Send it again.",
      data: { cause: 'bot_chat_changed', filesMaybeKept: true, unattachedUploads: 1 }
    })
    expect(claimsOn(committed[0]!)).toEqual([B_OTHER])
    expect(b.db.getInbox(10)).toEqual([])
  })
  it.each([
    ['with no item', {}],
    ['about an item', { item: '7' }]
  ])(
    'keeps the claims of mail stored %s when a later step there fails, and says it was delivered',
    async (_name, item) => {
      vi.mocked(b.runtime.notifyMessageArrived).mockImplementation(() => {
        throw new Error('wake failed')
      })
      const relay = vi
        .spyOn(a.runtime, 'ensureOrchestrationPeerMailRelay')
        .mockImplementation(() => {})

      await expect(send({ to: 'bot:Docs', ...item, files: [file] })).rejects.toMatchObject({
        code: 'peer_mail_stored',
        message: 'The message was delivered with its files, then this failed: wake failed',
        data: { effectsApplied: true }
      })
      expect(b.db.getUnreadMessages(CHAT_ON_B)).toHaveLength(1)
      expect(claimsOn(committed[0]!)).toEqual([B_SESSION])
      // The question is stored there, so A keeps waiting for its answer, or tells the asker on unpair,
      // and pulls that answer.
      expect(questionsOut()).toBe(1)
      expect(relay).toHaveBeenCalledWith('env_b')
    }
  )

  it('gives back only the claim its own send took, not one taken anew since', async () => {
    const path = await bStore.storeFile('shared.txt', Buffer.from('x'))
    const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `@${path}` }] }
    const claim = (now: number) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a claim effect returns its referenced and inserted uploads.
      applyJournalWriterEffect(journal.db, bState, {
        kind: 'claim',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a user message naming one upload is all the claim reads.
        claim: { sessionId: B_SESSION, body: body as never, required: true, now }
      }) as { inserted: string[] }
    const { inserted } = claim(1000)
    // The chat dropped that claim, then took it again for other mail.
    applyJournalWriterEffect(journal.db, bState, {
      kind: 'release',
      sessionId: B_SESSION,
      uploadIds: inserted,
      claimedAt: 1000
    })
    claim(2000)

    applyJournalWriterEffect(journal.db, bState, {
      kind: 'release',
      sessionId: B_SESSION,
      uploadIds: inserted,
      claimedAt: 1000
    })

    expect(claimsOn(path)).toEqual([B_SESSION])
  })
  it('forgets a question whose delivery outcome is unknown, as before, and arms the reply relay', async () => {
    deliveryTimesOut = true
    const relay = vi
      .spyOn(a.runtime, 'ensureOrchestrationPeerMailRelay')
      .mockImplementation(() => {})

    await expect(send({ to: 'bot:Docs', files: [file] })).rejects.toMatchObject({
      code: 'runtime_timeout',
      message: 'Timed out'
    })
    // It may never have arrived: kept, it would settle a later reply in its thread.
    expect(questionsOut()).toBe(0)
    expect(relay).toHaveBeenCalledWith('env_b')
  })
  it('says a retried delivery of stored mail with files was delivered when linking it fails', async () => {
    await send({ to: 'bot:Docs', files: [file] })
    const delivered = calls.find(({ method }) => method === 'orchestration.peerMailDeliver')!
    // Stored, yet its link was never written: the case a retry finds and links.
    b.db.db.prepare('DELETE FROM peer_mail_messages').run()
    vi.spyOn(b.db, 'linkPeerMailMessage').mockImplementation(() => {
      throw new Error('database is locked')
    })

    const retried = await transport.call('devB', 'orchestration.peerMailDeliver', delivered.params)

    expect(retried).toMatchObject({
      ok: false,
      error: { code: 'peer_mail_stored', data: { effectsApplied: true } }
    })
    expect(b.db.getUnreadMessages(CHAT_ON_B)).toHaveLength(1)
  })
})
