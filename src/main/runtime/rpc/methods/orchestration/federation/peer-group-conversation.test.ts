import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_GROUP_CONVERSATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { BotGroup } from '../../../../../../shared/bots/bot-group'
import type { RuntimeRpcResponse } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { runtimeBotGroups } from '../../../../../bots/bot-group-runtime'
import { handOffGroupMentions } from '../../../../../bots/bot-group-mention-handoffs'
import { settleStoredRoomMail } from '../../../../../bots/bot-group-remote-answers'
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

vi.mock(
  '../../../../orchestration/federation/relay/federation-relay-scheduler',
  async (original) => ({
    ...(await original<object>()),
    federationRelayRetryDelayMs: () => 0
  })
)

function start(path: string, transport?: OrchestrationEnvironmentTransport) {
  const db = new OrchestrationDb(path)
  const runtime = new OrcaRuntimeService(null, undefined, {
    orchestrationEnvironmentTransport: transport
  })
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime.bots, 'enabled').mockReturnValue(true)
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
  // Only the native agent is substituted; peer admission, mail, group storage, relay and wake routing are real.
  const native = {
    deps: {
      store: {
        getConversation: (id: string) => records.find((record) => record.sessionId === id) ?? null,
        listConversations: () => records,
        requireWritableRecord: () => ({ lease: { runtimeFence: 1 } })
      }
    },
    conversation: async () => ({
      journal: { queuedMessages: { failureHolds: async () => false } }
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
      return { ok: true, value: { clientMessageId: id } }
    },
    cancel: async () => ({ ok: true })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only native reads, send, and cancel are used by this fixture.
  setStructuredAgentSessionHost(native as unknown as StructuredAgentSessionHost)
  const hosts = new Map([
    ['atlas', start(join(directory, 'atlas.db'))],
    ['docs', start(join(directory, 'docs.db'))]
  ])
  const atlasHost = hosts.get('atlas')!
  const docsHost = hosts.get('docs')!
  let loseAck = false
  let legacyDocs = false
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the in-process transport carries the real dispatcher response.
      return (await host.dispatcher.dispatch(
        {
          id: method,
          method,
          params,
          authToken: 'room',
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
        },
        {
          authenticatedCallerFingerprint: `room-${selector}`,
          pairedDeviceId: `device-${selector}`,
          clientKind: 'runtime'
        }
      )) as RuntimeRpcResponse<unknown>
    }
  }
  vi.spyOn(atlasHost.runtime.bots, 'list').mockReturnValue([atlas])
  vi.spyOn(docsHost.runtime.bots, 'list').mockReturnValue([docs])
  let host = start(join(directory, 'room.db'), transport)
  function roomRuntime() {
    vi.spyOn(host.runtime.bots, 'list').mockReturnValue([local])
    return runtimeBotGroups(host.runtime)
  }
  let groups = roomRuntime()
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
  try {
    groups.store.put(group)
    const root = await post('@Atlas @Scout Test only: verify the room relay.')
    await vi.waitFor(() => expect(aMail()[0]?.body).toContain('verify the room relay'))
    const first = aMail()[0]!.id
    await expect(
      answer(first, '@Scout verify step 1. `@Docs` is quoted code.', aContext)
    ).resolves.toBeTruthy()
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
      expect(deliveredLocally.get(localAsk.turns[0]!.operationId)).toContain('verify step 1')
    )
    await handOffGroupMentions(groups, localAsk, localAsk.turns[0]!, {
      full: '@Atlas step 1 passed.',
      saved: '@Atlas step 1 passed.'
    })
    await vi.waitFor(() =>
      expect(aMail().find((row) => row.thread_id === first)?.body).toContain('step 1 passed')
    )
    expect(bMail()).toEqual([])

    const body = '@Docs check the signature, please.'
    const postContext = botContext(atlasHost.runtime, atlas.chatSessionId!, 'exact-follow-up')
    const groupPost = (ctx: RpcContext) =>
      ORCHESTRATION_GROUP_POST_METHOD.handler({ id: first, body }, ctx)
    expect(() => groupPost(botContext(atlasHost.runtime, docs.chatSessionId!))).toThrow(
      expect.objectContaining({ code: 'request_mismatch' })
    )
    loseAck = true
    expect(groupPost(postContext)).toMatchObject({ status: 'queued' })
    groupPost(postContext)
    await vi.waitFor(() => expect(bMail()[0]?.body).toContain('check the signature'))
    const docsAsk = bMail()[0]!.id
    expect(rows().filter((row) => row.text === body)).toMatchObject([
      { remoteAuthor: { name: 'Atlas' }, rootRequestId: root.id, threadId }
    ])
    expect(
      rows().find((row) => row.remoteAsks?.some((ask) => ask.requestId === docsAsk))?.requester
        ?.name
    ).toBe('Atlas')
    await answer(docsAsk, '@Atlas Signature verified.', bContext)
    await vi.waitFor(() =>
      expect(aMail().filter((mail) => mail.body.includes('Signature verified.'))).toMatchObject([
        { thread_id: first, payload: '{"groupContinuation":true}' }
      ])
    )
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
    await answer(bMail()[0]!.id, 'Archive verified.', bContext)
    await vi.waitFor(() =>
      expect(
        [...deliveredLocally.values()].some(
          (text) => text.includes('For context only: Docs') && text.includes('Archive verified.')
        )
      ).toBe(true)
    )

    const separately = await post('@Atlas Start the attestation review.')
    await vi.waitFor(() => expect(aMail()[0]?.body).toContain('attestation review'))
    await answer(aMail()[0]!.id, '@Docs inspect the attestation.', aContext)
    await vi.waitFor(() => expect(bMail()[0]?.body).toContain('inspect the attestation'))
    expect(
      rows().find((row) => row.remoteAsks?.some((ask) => ask.requestId === bMail()[0]?.id))
        ?.rootRequestId
    ).toBe(separately.id)

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

    host.runtime.stopOrchestrationFederationRelay()
    host.db.close()
    host = start(join(directory, 'room.db'), transport)
    groups = roomRuntime()
    settleStoredRoomMail(groups)
    groups.resumePending()
    host.runtime.ensureOrchestrationFederationRelay()
    expect(
      groups.store.roomMessages(group.id, threadId, 100).filter((row) => row.text === body)
    ).toHaveLength(1)
    expect(bMail().filter((mail) => docsHost.db.getBotRequest(mail.id))).toHaveLength(3)

    legacyDocs = true
    const legacy = await post('@Docs Legacy question.')
    await vi.waitFor(() => expect(bMail()[0]?.body).toContain('Legacy question'))
    const legacyId = bMail()[0]!.id
    await answer(legacyId, 'Legacy answer.', bContext)
    expect(() => ORCHESTRATION_GROUP_POST_METHOD.handler({ id: legacyId, body }, bContext)).toThrow(
      expect.objectContaining({ code: 'request_mismatch' })
    )
    await vi.waitFor(() =>
      expect(groups.store.message(legacy.id)?.remoteAsks?.[0]?.reply).toMatchObject({
        text: 'Legacy answer.'
      })
    )
    expect(groups.store.roomMessages(group.id, undefined)).toEqual([])
  } finally {
    setStructuredAgentSessionHost(null)
    for (const side of [host, ...hosts.values()]) {
      side.runtime.stopOrchestrationFederationRelay()
      side.db.close()
    }
    rmSync(directory, { recursive: true, force: true })
  }
})
