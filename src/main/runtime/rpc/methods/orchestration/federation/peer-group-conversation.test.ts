import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { z } from 'zod'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_GROUP_CONVERSATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { botGroupRemoteKey, type BotGroup } from '../../../../../../shared/bots/bot-group'
import { botGroupRoomMailAddress } from '../../../../../../shared/bots/bot-group-room-mail'
import type { RuntimeRpcResponse } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { runtimeBotGroups } from '../../../../../bots/bot-group-runtime'
import { handOffGroupMentions } from '../../../../../bots/bot-group-mention-handoffs'
import { isRemoteAskInFlight } from '../../../../../bots/bot-group-peer-delivery'
import {
  remoteRoomMailArrived,
  settleStoredRoomMail
} from '../../../../../bots/bot-group-remote-answers'
import { Store } from '../../../../../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore
} from '../../../../../persistence/persistence-test-harness'
import { makeTestBot } from '../../../../../bots/bot.test-fixture'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/federation/environment-transport'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcContext } from '../../../core'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { ORCHESTRATION_REPLY_METHOD } from '../messaging/reply-method'
import { ORCHESTRATION_GROUP_POST_METHOD } from '../messaging/group-post-method'
import { PeerMailDeliverParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { GroupPostParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'
import { formatMessageBannerWithContent } from '../../../../orchestration/mailbox/formatting/message-formatting'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

vi.mock(
  '../../../../orchestration/federation/relay/federation-relay-scheduler',
  async (original) => ({
    ...(await original<object>()),
    federationRelayRetryDelayMs: () => 0
  })
)

function start(path: string, store: Store | null, transport?: OrchestrationEnvironmentTransport) {
  const db = new OrchestrationDb(path)
  let runtime: OrcaRuntimeService | undefined
  onTestFinished(() => {
    runtime?.stopOrchestrationFederationRelay()
    if (db.db.isOpen) {
      db.close()
    }
  })
  runtime = new OrcaRuntimeService(store, undefined, {
    orchestrationEnvironmentTransport: transport
  })
  runtime.setOrchestrationDb(db)
  if (!store) {
    vi.spyOn(runtime.bots, 'enabled').mockReturnValue(true)
  }
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockResolvedValue()
  return { db, runtime, dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }) }
}

function botContext(
  runtime: OrcaRuntimeService,
  sessionId: string,
  requestId?: string
): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same caller fields the CLI projects for a local native chat.
  return {
    runtime,
    orchestrationCaller: {
      address: `orca_session_id:${sessionId}`,
      orcaSessionId: sessionId,
      sessionId,
      terminalHandle: null,
      paneKey: null
    },
    ...(requestId ? { orchestrationMutation: { callerFingerprint: sessionId, requestId } } : {})
  } as RpcContext
}

it('keeps two remote Homes and the local member in the same group request without duplicate or post-Stop wakes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-group-conversation-'))
  onTestFinished(async () => {
    await closeTestStores()
    rmSync(directory, { recursive: true, force: true })
  })
  const atlas = makeTestBot({ id: 'same-bot-id', name: 'Atlas', chatSessionId: randomUUID() })
  const docs = makeTestBot({ id: atlas.id, name: 'Docs', chatSessionId: randomUUID() })
  const local = makeTestBot({ name: 'Scout' })
  const localSession = `bot-group-member-${randomUUID()}`
  const records = [atlas, docs, { ...local, chatSessionId: localSession }].map((bot) => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({ sessionId: bot.chatSessionId! })
    )
    return agentSessionConversationView({
      ...record,
      location: { ...record.location, workspaceId: folderWorkspaceKey(bot.folderWorkspaceId) }
    })
  })
  const deliveredLocally = new Map<string, string>()
  const nativeSends: { id: string; text: string }[] = []
  let admission:
    | {
        entered: PromiseWithResolvers<void>
        release: PromiseWithResolvers<void>
        attempt?: z.infer<typeof PeerMailDeliverParams>
        result?: Promise<RuntimeRpcResponse<unknown>>
        overlapping?: boolean
        explicitRetry?: boolean
      }
    | undefined
  // Only the native agent is substituted; peer admission, mail, group storage, relay and wake routing are real.
  const native = {
    deps: {
      store: {
        getConversation: (id: string) => records.find((record) => record.sessionId === id) ?? null,
        listConversations: () => records,
        requireWritableRecord: () => ({ lease: { runtimeFence: 1 } })
      }
    },
    conversation: async (id: string) => ({
      journal: {
        queuedMessages: {
          failureHolds: async () => {
            if (id === atlas.chatSessionId && admission) {
              admission.entered.resolve()
              await admission.release.promise
            }
            return false
          }
        }
      }
    }),
    captureAgentStartDestination: async (id: string) => id,
    appendAgentStart: async () => {},
    observeConversationPublications: () => () => {},
    setUserConversationName: async () => {},
    journalReads: async () => ({
      operationSent: (id: string) => deliveredLocally.has(id),
      operationWindow: async () => ({ snapshot: { items: [], submissions: [] } })
    }),
    send: async (
      _: unknown,
      input: {
        envelope: { clientOperationId: string }
        body: { blocks: { text: string }[] }
        beforeRun?: () => void
      }
    ) => {
      input.beforeRun?.()
      const id = input.envelope.clientOperationId
      deliveredLocally.set(id, input.body.blocks[0].text)
      nativeSends.push({ id, text: input.body.blocks[0].text })
      return { ok: true, value: { clientMessageId: id } }
    },
    cancel: async () => ({ ok: true })
  }
  onTestFinished(() => setStructuredAgentSessionHost(null))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only native reads, send, and cancel are used by this fixture.
  setStructuredAgentSessionHost(native as unknown as StructuredAgentSessionHost)
  const hosts = new Map([
    ['atlas', start(join(directory, 'atlas.db'), null)],
    ['docs', start(join(directory, 'docs.db'), null)]
  ])
  const atlasHost = hosts.get('atlas')!
  const docsHost = hosts.get('docs')!
  let loseAck = false
  let legacyDocs = false
  let legacyRoom = false
  let interruptAnswer = false
  let probeFailed = false
  let holdProbe: PromiseWithResolvers<void> | undefined
  let probing = false
  let muteRoom = false
  let blockProbe = false
  let loseAnswerReceipt = false
  let interruptedId: string | undefined
  let lostReceiptId: string | undefined
  const transport: OrchestrationEnvironmentTransport = {
    resolve: (selector) => ({
      environmentId: selector,
      name: selector,
      peerFingerprint: `peer-${selector}`,
      homePeerFingerprint: `room-${selector}`
    }),
    call: async (selector, method, params) => {
      const host = hosts.get(selector)!
      if (method === 'status.get') {
        if (holdProbe && selector === 'atlas') {
          probing = true
          await holdProbe.promise
        }
        if (blockProbe && selector === 'atlas') {
          probeFailed = true
          throw new OrchestrationError('runtime_unavailable', 'test: status transport retired')
        }
        const status = host.runtime.getStatus()
        return {
          id: method,
          ok: true,
          _meta: { runtimeId: host.runtime.getRuntimeId() },
          result: {
            ...status,
            capabilities: status.capabilities?.filter(
              (capability) =>
                !(
                  legacyDocs &&
                  selector === 'docs' &&
                  capability === ORCHESTRATION_GROUP_CONVERSATION_RUNTIME_CAPABILITY
                )
            )
          }
        }
      }
      if (loseAck && selector === 'atlas' && method === 'orchestration.peerMailAck') {
        loseAck = false
        throw new Error('ack was lost')
      }
      const delivery =
        method === 'orchestration.peerMailDeliver' ? PeerMailDeliverParams.parse(params) : undefined
      const answerId = delivery?.group?.kind === 'answer' ? delivery.messageId : undefined
      if (answerId && (interruptAnswer || answerId === lostReceiptId)) {
        interruptedId ??= answerId
        throw new OrchestrationError('runtime_timeout', 'test: no delivery response')
      }
      let wireParams = params
      if (
        legacyRoom &&
        (method === 'orchestration.peerMailPull' || method === 'orchestration.peerMailAck') &&
        params &&
        typeof params === 'object' &&
        'groupPosts' in params
      ) {
        const { groupPosts: _groupPosts, ...legacy } = params
        wireParams = legacy
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the in-process transport carries the real dispatcher response.
      const received = host.dispatcher.dispatch(
        {
          id: method,
          method,
          params: wireParams,
          authToken: 'room',
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
        },
        {
          authenticatedCallerFingerprint: `room-${selector}`,
          pairedDeviceId: `device-${selector}`,
          clientKind: 'runtime'
        }
      ) as Promise<RuntimeRpcResponse<unknown>>
      const gated =
        admission && selector === 'atlas' && delivery?.group?.kind === 'question'
          ? admission
          : undefined
      if (gated && delivery) {
        if (!gated.result) {
          gated.attempt = delivery
          gated.result = received
          await gated.entered.promise
          throw new OrchestrationError(
            'runtime_timeout',
            'test: first attempt is still in admission'
          )
        }
        expect(delivery).toEqual(gated.attempt)
      }
      const response = await received
      if (gated && !response.ok && response.error.code === 'delivery_in_progress') {
        gated.overlapping = true
        if (gated.explicitRetry) {
          return { ...response, error: { ...response.error, code: 'test_temporary_admission' } }
        }
      }
      if (answerId && loseAnswerReceipt && response.ok) {
        loseAnswerReceipt = false
        lostReceiptId = answerId
        throw new OrchestrationError('runtime_timeout', 'test: response lost after peer commit')
      }
      return response
    }
  }
  const atlasList = vi.spyOn(atlasHost.runtime.bots, 'list').mockReturnValue([atlas])
  vi.spyOn(docsHost.runtime.bots, 'list').mockReturnValue([docs])
  const roomPrefs = createSqliteTestStore(Store, {
    dataFile: join(directory, 'room', 'state.json')
  })
  roomPrefs.updateSettings({ botsEnabled: true })
  let host = start(join(directory, 'room.db'), roomPrefs, transport)
  function roomRuntime() {
    vi.spyOn(host.runtime.bots, 'list').mockReturnValue([local])
    const notify = host.runtime.notifyMessageArrived.bind(host.runtime)
    vi.spyOn(host.runtime, 'notifyMessageArrived').mockImplementation((to, type) => {
      if (!muteRoom || to !== roomAddress) {
        notify(to, type)
      }
    })
    return runtimeBotGroups(host.runtime)
  }
  const threadId = randomUUID()
  const group: BotGroup = {
    id: randomUUID(),
    name: 'Field Notes',
    folder: directory,
    folderWorkspaceId: 'field-notes',
    hostId: 'local',
    revision: 1,
    createdAt: 0,
    replyMode: { kind: 'mentions' },
    members: [{ botId: local.id, sessionId: `bot-group-member-${randomUUID()}` }],
    threads: [
      { id: threadId, createdAt: 0, members: [{ botId: local.id, sessionId: localSession }] }
    ],
    remoteMembers: [
      { bot: atlas, environment: 'atlas' },
      { bot: docs, environment: 'docs' }
    ].map(({ bot: entry, environment }) => {
      const { id: botId, name, avatar, agent, chatSessionId } = entry
      return {
        botId,
        name,
        avatar,
        agent,
        chatSessionId: chatSessionId!,
        environmentId: environment,
        computer: environment,
        joinedAfter: 0
      }
    })
  }
  const roomAddress = botGroupRoomMailAddress(group.id)
  let groups = roomRuntime()
  const rows = () => groups.read(group.id, undefined, threadId).messages
  const inbox = (side: typeof host, sessionId: string) =>
    side.db.getInbox(100).filter((mail) => mail.to_handle === `orca_session_id:${sessionId}`)
  const aMail = () => inbox(atlasHost, atlas.chatSessionId!)
  const bMail = () => inbox(docsHost, docs.chatSessionId!)
  const aContext = botContext(atlasHost.runtime, atlas.chatSessionId!)
  const bContext = botContext(docsHost.runtime, docs.chatSessionId!)
  const post = (text: string) =>
    groups.send({
      groupId: group.id,
      threadId,
      revision: groups.store.get(group.id).revision,
      messageId: randomUUID(),
      text
    })
  const answer = (id: string, body: string, ctx: RpcContext) =>
    ORCHESTRATION_REPLY_METHOD.handler({ id, body }, ctx)
  const restartRoom = () => {
    host.runtime.stopOrchestrationFederationRelay()
    host.db.close()
    host = start(join(directory, 'room.db'), roomPrefs, transport)
    groups = roomRuntime()
    settleStoredRoomMail(groups)
    groups.resumePending()
    host.runtime.ensureOrchestrationFederationRelay()
  }
  try {
    groups.store.put(group)
    const root = await post('@Atlas @Scout Test only: verify the room relay.')
    await vi.waitFor(() => expect(aMail()[0]?.body).toContain('verify the room relay'))
    const first = aMail()[0]!.id
    const longReply = `${'x'.repeat(63_990)} @Scout`
    await expect(answer(first, longReply, aContext)).resolves.toBeTruthy()
    await expect(answer(first, 'Different answer.', aContext)).rejects.toMatchObject({
      code: 'already_answered',
      message: expect.stringContaining('group-post')
    })
    await vi.waitFor(() =>
      expect(rows().find((row) => row.requester?.name === 'Atlas')?.turns[0]?.botName).toBe('Scout')
    )
    const localAsk = groups.store
      .roomMessages(group.id, threadId)
      .find((row) => row.requester?.name === 'Atlas')!
    await vi.waitFor(() =>
      expect(deliveredLocally.get(localAsk.turns[0]!.operationId)).toContain('x @Scout')
    )
    interruptAnswer = true
    blockProbe = true
    await handOffGroupMentions(groups, localAsk, localAsk.turns[0]!, {
      full: '@Atlas step 1 passed.',
      saved: '@Atlas step 1 passed.'
    })
    await vi.waitFor(() => expect(probeFailed).toBe(true))
    const [waiting] = groups.store.routes.pendingRemoteDeliveries(group.id)
    expect(waiting).toMatchObject({ isAnswer: true, messageId: localAsk.id })
    expect(atlasHost.db.getMessageById(waiting!.id)).toBeUndefined()
    blockProbe = false
    await vi.waitFor(() => expect(interruptedId).toBe(waiting!.id))
    expect(groups.store.routes.pendingRemoteDeliveries(group.id)).toContainEqual(
      expect.objectContaining({ id: interruptedId, isAnswer: true })
    )
    expect(atlasHost.db.getMessageById(interruptedId!)).toBeUndefined()
    interruptAnswer = false
    restartRoom()
    await vi.waitFor(() =>
      expect(aMail().filter((row) => row.thread_id === first)).toMatchObject([
        { id: interruptedId, body: expect.stringContaining('step 1 passed') }
      ])
    )
    expect(bMail()).toEqual([])

    const body = '@Docs check the signature, please.'
    const postContext = botContext(atlasHost.runtime, atlas.chatSessionId!, 'exact-follow-up')
    const groupPost = (ctx: RpcContext) =>
      ORCHESTRATION_GROUP_POST_METHOD.handler({ id: first, body }, ctx)
    expect(() => groupPost(botContext(atlasHost.runtime, docs.chatSessionId!))).toThrow(
      expect.objectContaining({ code: 'request_mismatch' })
    )
    legacyRoom = true
    restartRoom()
    const queued = groupPost(postContext)
    expect(queued).toMatchObject({ status: 'queued' })
    groupPost(postContext)
    const originalConversation = atlasHost.db.getPeerMailMessage(first)!.conversation_id
    const ordinary = await post('@Atlas Legacy host still takes first replies.')
    await vi.waitFor(() => expect(aMail()[0]?.body).toContain('still takes first replies'))
    const ordinaryId = aMail()[0]!.id
    await answer(ordinaryId, 'Normal reply through the rolled-back host.', aContext)
    await vi.waitFor(() =>
      expect(groups.store.message(ordinary.id)?.remoteAsks?.[0]?.reply).toMatchObject({
        text: 'Normal reply through the rolled-back host.'
      })
    )
    await vi.waitFor(() =>
      expect(
        atlasHost.db
          .listPendingFederationRelay(originalConversation, 'to_home')
          .map((relay) => relay.message_id)
      ).toEqual([queued.messageId])
    )
    expect(rows().some((row) => row.text === body)).toBe(false)
    expect(bMail()).toEqual([])
    loseAck = true
    legacyRoom = false
    restartRoom()
    await vi.waitFor(() => expect(bMail()[0]?.body).toContain('check the signature'))
    const docsAsk = bMail()[0]!.id
    expect(rows().filter((row) => row.text === body)).toMatchObject([
      { remoteAuthor: { name: 'Atlas' }, rootRequestId: root.id, threadId }
    ])
    expect(
      rows().find((row) => row.remoteAsks?.some((ask) => ask.requestId === docsAsk))?.requester
        ?.name
    ).toBe('Atlas')
    const suspendRoomAnswer = async (questionId: string, text: string) => {
      muteRoom = true
      roomPrefs.updateSettings({ botsEnabled: false }, { notifyListeners: true })
      await answer(questionId, text, bContext)
      const incoming = () =>
        host.db.getUnreadMessages(roomAddress).find((row) => row.thread_id === questionId)
      await vi.waitFor(() => expect(incoming()).toBeDefined())
      const mailId = incoming()!.id
      const asks = rows().flatMap((row) => row.remoteAsks ?? [])
      expect(asks.find((ask) => ask.requestId === questionId)?.reply).toMatchObject({ text })
      await groups.queues.get(group.id)
      expect(groups.store.routes.pendingMailRoutes(group.id)).toEqual([
        { mailId, requestId: questionId, isPost: false }
      ])
      muteRoom = false
    }
    await suspendRoomAnswer(docsAsk, '@Atlas Signature verified.')
    expect(aMail().some((mail) => mail.body.includes('Signature verified.'))).toBe(false)
    loseAnswerReceipt = true
    roomPrefs.updateSettings({ botsEnabled: true }, { notifyListeners: true })
    await vi.waitFor(() => expect(lostReceiptId).toBeDefined())
    expect(groups.store.routes.pendingRemoteDeliveries(group.id)).toContainEqual(
      expect.objectContaining({ id: lostReceiptId, isAnswer: true })
    )
    const continuation = atlasHost.db.getMessageById(lostReceiptId!)!
    expect(continuation).toMatchObject({ thread_id: first, payload: '{"groupContinuation":true}' })
    const banner = formatMessageBannerWithContent(continuation, { peerMail: atlasHost.db }).text
    expect(banner).toContain('Signature verified.')
    expect(banner).toContain('context only')
    expect(banner).not.toContain('orchestration reply')
    for (const authority of ['legacy_compatibility', 'legacy_recovery_replay'] as const) {
      const options = {
        peerMail: atlasHost.db,
        authority,
        supportedActionHints: ['orca orchestration reply --id example']
      }
      const legacyBanner = formatMessageBannerWithContent(continuation, options).text
      expect(legacyBanner).toContain('context only')
      expect(legacyBanner).not.toContain('Supported action')
    }
    await expect(answer(continuation.id, 'Not a request.', aContext)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    const ordinaryPayload = atlasHost.db.insertMessage({
      from: continuation.from_handle,
      to: continuation.to_handle,
      subject: 'Ordinary mail with a user payload',
      body: 'Ask me if anything is unclear.',
      type: 'status',
      payload: continuation.payload ?? undefined
    })
    const ordinaryBanner = formatMessageBannerWithContent(ordinaryPayload, {
      peerMail: atlasHost.db
    }).text
    expect(ordinaryBanner).toContain(`orchestration reply --id ${ordinaryPayload.id}`)
    expect(ordinaryBanner).toContain('[Payload: {"groupContinuation":true}]')
    const receivedId = lostReceiptId
    lostReceiptId = undefined
    restartRoom()
    await vi.waitFor(() =>
      expect(groups.store.routes.pendingRemoteDeliveries(group.id)).toEqual([])
    )
    expect(aMail().filter((mail) => mail.body.includes('Signature verified.'))).toMatchObject([
      { id: receivedId, thread_id: first }
    ])
    expect(
      rows()
        .flatMap((row) => row.remoteAsks ?? [])
        .find((ask) => ask.requestId === docsAsk)?.reply
    ).toMatchObject({ text: '@Atlas Signature verified.' })
    expect(
      atlasHost.db.getBotRequest(
        aMail().find((mail) => mail.body.includes('Signature verified.'))!.id
      )
    ).toBeUndefined()

    await handOffGroupMentions(groups, root, root.turns[0]!, {
      full: '@Docs verify the archive too.',
      saved: '@Docs verify the archive too.'
    })
    await vi.waitFor(() => expect(bMail()[0]?.body).toContain('verify the archive'))
    muteRoom = true
    await answer(bMail()[0]!.id, 'Archive verified.', bContext)
    // Lose the arrival nudge after import; the reader must still route the answer to the asker.
    await vi.waitFor(() =>
      expect(host.db.getUnreadMessages(roomAddress)).toContainEqual(
        expect.objectContaining({ body: 'Archive verified.' })
      )
    )
    rows()
    const archiveSends = () =>
      nativeSends.filter(
        ({ text }) => text.includes('For context only: Docs') && text.includes('Archive verified.')
      )
    await vi.waitFor(() => expect(archiveSends()).toHaveLength(1))
    muteRoom = false
    settleStoredRoomMail(groups)
    await groups.queues.get(group.id)
    expect(archiveSends()).toHaveLength(1)

    const separately = await post('@Atlas Start the attestation review.')
    await vi.waitFor(() => expect(aMail()[0]?.body).toContain('attestation review'))
    await answer(aMail()[0]!.id, '@Docs inspect the attestation.', aContext)
    await vi.waitFor(() => expect(bMail()[0]?.body).toContain('inspect the attestation'))
    expect(
      rows().find((row) => row.remoteAsks?.some((ask) => ask.requestId === bMail()[0]?.id))
        ?.rootRequestId
    ).toBe(separately.id)
    await suspendRoomAnswer(bMail()[0]!.id, 'The attestation stays in the room after Stop.')
    await groups.stop(group.id, botGroupRemoteKey(group.remoteMembers![1]), threadId)
    roomPrefs.updateSettings({ botsEnabled: true }, { notifyListeners: true })
    await groups.queues.get(group.id)
    expect(groups.store.routes.pendingMailRoutes(group.id)).toEqual([])
    expect(groups.store.routes.pendingRemoteDeliveries(group.id)).toEqual([])
    expect(
      aMail().filter((mail) => mail.thread_id === separately.remoteAsks![0].requestId)
    ).toEqual([])

    const oversized = GroupPostParams.parse({ id: first, body: '한'.repeat(22_000) })
    expect(() => ORCHESTRATION_GROUP_POST_METHOD.handler(oversized, aContext)).toThrow(
      expect.objectContaining({
        code: 'relay_quota_exceeded',
        message: expect.stringContaining('64 KiB when serialized as UTF-8')
      })
    )
    const fits = GroupPostParams.parse({ id: first, body: 'x'.repeat(64_001) })
    const largePost = ORCHESTRATION_GROUP_POST_METHOD.handler(fits, aContext)
    expect(largePost).toMatchObject({ status: 'queued' })
    await vi.waitFor(() =>
      expect(rows().find((row) => row.id === `group-post:${largePost.messageId}`)?.text).toBe(
        `${fits.body.slice(0, 16_000)}…`
      )
    )
    expect(groups.store.message(`group-post:${largePost.messageId}`)?.text).toBe(fits.body)

    const stopped = await post('@Atlas Older question still in progress.')
    await vi.waitFor(() => expect(aMail()[0]?.body).toContain('Older question'))
    const stoppedAsk = aMail()[0]!.id
    for (let i = 0; i < 41; i += 1) {
      await post('Unaddressed timeline entry.')
    }
    await groups.stop(group.id, undefined, threadId)
    await answer(stoppedAsk, '@Docs Do not wake after Stop.', aContext)
    await vi.waitFor(() =>
      expect(groups.store.message(stopped.id)?.remoteAsks?.[0]?.reply).toMatchObject({
        text: '@Docs Do not wake after Stop.'
      })
    )
    await vi.waitFor(() => expect(groups.store.routes.pendingMailRoutes(group.id)).toEqual([]))

    restartRoom()
    expect(
      groups.store.roomMessages(group.id, threadId, 100).filter((row) => row.text === body)
    ).toHaveLength(1)
    expect(bMail().filter((mail) => docsHost.db.getBotRequest(mail.id))).toHaveLength(3)

    legacyDocs = true
    const legacy = await post('@Docs Legacy question.')
    await vi.waitFor(() => expect(bMail()[0]?.body).toContain('Legacy question'))
    const legacyId = bMail()[0]!.id
    await answer(legacyId, 'Legacy answer.', bContext)
    await expect(answer(legacyId, 'Second legacy answer.', bContext)).rejects.toMatchObject({
      code: 'already_answered',
      message: "You already answered that request, so send new mail if there's more to say."
    })
    expect(() => ORCHESTRATION_GROUP_POST_METHOD.handler({ id: legacyId, body }, bContext)).toThrow(
      expect.objectContaining({ code: 'request_mismatch' })
    )
    await vi.waitFor(() =>
      expect(groups.store.message(legacy.id)?.remoteAsks?.[0]?.reply).toMatchObject({
        text: 'Legacy answer.'
      })
    )
    expect(groups.store.roomMessages(group.id, undefined)).toEqual([])

    legacyDocs = false
    const beforeDowngrade = await post('@Atlas Root before authority downgrade.')
    await vi.waitFor(() => expect(aMail()[0]?.body).toContain(beforeDowngrade.text))
    const beforeDowngradeId = aMail()[0]!.id
    await answer(beforeDowngradeId, '@Docs Reply before the next maintenance window.', aContext)
    await vi.waitFor(() => expect(bMail()[0]?.body).toContain('next maintenance window'))
    const gatedQuestion = bMail()[0]!.id
    const gatedConversation = docsHost.db.getPeerMailMessage(gatedQuestion)!.conversation_id
    legacyRoom = true
    restartRoom()
    const lateAnswer = 'Gated reply, never imported by a legacy merger.'
    await answer(gatedQuestion, lateAnswer, bContext)
    const ordinaryDuringRollback = await post('@Docs Ordinary legacy reply can drain.')
    await vi.waitFor(() => expect(bMail()[0]?.body).toContain(ordinaryDuringRollback.text))
    await answer(bMail()[0]!.id, 'Ordinary reply drained.', bContext)
    await vi.waitFor(() =>
      expect(groups.store.message(ordinaryDuringRollback.id)?.remoteAsks?.[0]?.reply).toMatchObject(
        {
          text: 'Ordinary reply drained.'
        }
      )
    )
    await vi.waitFor(() =>
      expect(docsHost.db.listPendingFederationRelay(gatedConversation, 'to_home')).toMatchObject([
        { kind: 'group_reply', payload: expect.stringContaining(lateAnswer) }
      ])
    )
    expect(
      rows()
        .flatMap((row) => row.remoteAsks ?? [])
        .find((ask) => ask.requestId === gatedQuestion)?.reply
    ).toBeUndefined()
    legacyRoom = false
    restartRoom()
    await vi.waitFor(() =>
      expect(aMail().filter((row) => row.body.includes(lateAnswer))).toMatchObject([
        { thread_id: beforeDowngradeId }
      ])
    )

    legacyRoom = true
    restartRoom()
    const stoppedPost = ORCHESTRATION_GROUP_POST_METHOD.handler(
      { id: beforeDowngradeId, body: '@Docs This follow-up must not cross legacy Stop.' },
      aContext
    )
    const put = groups.store.put.bind(groups.store)
    const legacyStopWrite = vi.spyOn(groups.store, 'put').mockImplementationOnce((record) => {
      // The old Stop writes the room revision and local cutoff but has no remote-stop fields.
      const { remoteStops: _stops, legacyRemoteCutoff: _cutoff, ...old } = record
      host.db.db
        .prepare('UPDATE bot_groups SET record = ? WHERE id = ?')
        .run(JSON.stringify(old), old.id)
    })
    await groups.stop(group.id, undefined, threadId)
    legacyStopWrite.mockImplementation(put)
    expect(groups.store.get(group.id).legacyRemoteCutoff).toBeGreaterThanOrEqual(
      beforeDowngrade.sequence
    )
    const beforeStopConversation =
      atlasHost.db.getPeerMailMessage(beforeDowngradeId)!.conversation_id
    const docsRequestIds = bMail().map((row) => row.id)
    legacyRoom = false
    restartRoom()
    await vi.waitFor(() =>
      expect(atlasHost.db.listPendingFederationRelay(beforeStopConversation, 'to_home')).toEqual([])
    )
    expect(groups.store.message(`group-post:${stoppedPost.messageId}`)).toBeNull()
    expect(bMail().map((row) => row.id)).toEqual(docsRequestIds)
    const newRoot = await post('@Docs New root after authority rollforward.')
    await vi.waitFor(() =>
      expect(bMail().filter((row) => row.body.includes(newRoot.text))).toMatchObject([
        { id: newRoot.remoteAsks![0].requestId }
      ])
    )

    for (const firstAttemptSucceeds of [true, false]) {
      const gate = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
        explicitRetry: !firstAttemptSucceeds
      } satisfies NonNullable<typeof admission>
      admission = gate
      const question = await post(
        `@Atlas Retried question: ${firstAttemptSucceeds ? 'commit' : 'recover'}.`
      )
      const id = question.remoteAsks![0].requestId
      await vi.waitFor(() => expect(admission?.overlapping).toBe(true))
      expect(groups.store.routes.pendingRemoteDeliveries(group.id)).toContainEqual(
        expect.objectContaining({ id, messageId: question.id })
      )
      expect(groups.store.message(question.id)?.remoteAsks?.[0]?.state).toBe('unknown')
      expect(aMail().filter((row) => row.id === id)).toEqual([])
      const firstResult = admission.result!
      if (!firstAttemptSucceeds) {
        const admit = atlasHost.db.admitBotRequest.bind(atlasHost.db)
        const storage = vi.spyOn(atlasHost.db, 'admitBotRequest').mockImplementationOnce(() => {
          storage.mockImplementation(admit)
          throw new Error('test: first admission failed')
        })
      }
      gate.release.resolve()
      await expect(firstResult).resolves.toMatchObject({ ok: firstAttemptSucceeds })
      await vi.waitFor(() =>
        expect(groups.store.message(question.id)?.remoteAsks?.[0]?.state).toBe('sent')
      )
      admission = undefined
      expect(aMail().filter((row) => row.body.includes(question.text))).toMatchObject([{ id }])
      await answer(id, 'Received once.', aContext)
      await vi.waitFor(() =>
        expect(groups.store.message(question.id)?.remoteAsks?.[0]?.reply).toMatchObject({
          text: 'Received once.'
        })
      )
    }

    holdProbe = Promise.withResolvers<void>()
    const paused = await post('@Atlas Dispatch after settings enablement.')
    const pausedId = paused.remoteAsks![0].requestId
    await vi.waitFor(() => expect(probing).toBe(true))
    roomPrefs.updateSettings({ botsEnabled: false }, { notifyListeners: true })
    holdProbe.resolve()
    holdProbe = undefined
    await vi.waitFor(() => expect(isRemoteAskInFlight(pausedId)).toBe(false))
    expect(groups.store.routes.pendingRemoteDeliveries(group.id)).toContainEqual(
      expect.objectContaining({ id: pausedId, messageId: paused.id })
    )
    expect(atlasHost.db.getMessageById(pausedId)).toBeUndefined()
    const receivingNotify = atlasHost.runtime.notifyMessageArrived.bind(atlasHost.runtime)
    const replacedHome = { ...atlas, chatSessionId: randomUUID() }
    const afterAdmission = vi
      .spyOn(atlasHost.runtime, 'notifyMessageArrived')
      .mockImplementationOnce((to, type) => {
        receivingNotify(to, type)
        atlasList.mockReturnValue([replacedHome])
      })
    roomPrefs.updateSettings({ botsEnabled: true }, { notifyListeners: true })
    await vi.waitFor(() =>
      expect(groups.store.message(paused.id)?.remoteAsks?.[0]?.state).toBe('sent')
    )
    expect(aMail().filter((row) => row.id === pausedId)).toHaveLength(1)
    afterAdmission.mockRestore()
    atlasList.mockReturnValue([atlas])
    await answer(pausedId, 'Ready for the two follow-ups.', aContext)
    await vi.waitFor(() =>
      expect(groups.store.message(paused.id)?.remoteAsks?.[0]?.reply?.kind).toBe('answer')
    )

    muteRoom = true
    const acceptedPost = ORCHESTRATION_GROUP_POST_METHOD.handler(
      { id: pausedId, body: '@Scout route the committed post.' },
      aContext
    )
    const rejectedPost = ORCHESTRATION_GROUP_POST_METHOD.handler(
      { id: pausedId, body: '@Scout route this post after recovery.' },
      aContext
    )
    await vi.waitFor(() =>
      expect(host.db.getUnreadMessages(roomAddress).map(({ id }) => id)).toEqual([
        acceptedPost.messageId,
        rejectedPost.messageId
      ])
    )
    host.db.db.exec(`CREATE TRIGGER reject_one_route BEFORE DELETE ON bot_group_pending
      WHEN OLD.operation_id = 'remote-room-mail:${rejectedPost.messageId}'
      BEGIN SELECT RAISE(ABORT, 'test: second route cannot commit'); END;`)
    remoteRoomMailArrived(groups, group.id)
    await vi.waitFor(() =>
      expect(
        nativeSends.filter(({ text }) => text.includes('route the committed post.'))
      ).toHaveLength(1)
    )
    expect(groups.store.message(`group-post:${rejectedPost.messageId}`)).toBeNull()
    host.db.db.exec('DROP TRIGGER reject_one_route')
    muteRoom = false
    remoteRoomMailArrived(groups, group.id)
    await vi.waitFor(() =>
      expect(nativeSends.some(({ text }) => text.includes('route this post after recovery.'))).toBe(
        true
      )
    )
  } finally {
    admission?.release.resolve()
    holdProbe?.resolve()
  }
})
