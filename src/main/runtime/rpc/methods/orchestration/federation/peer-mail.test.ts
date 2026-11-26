import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_PEER_BOT_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_PEER_MAIL_TYPES_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { PeerMailSender } from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { makeTestBot } from '../../../../../bots/bot.test-fixture'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/federation/environment-transport'
import type { OrchestrationSessionCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcContext } from '../../../core'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { ORCHESTRATION_REPLY_METHOD } from '../messaging/reply-method'
import { notifyPeerMailQueued } from '../../../../orchestration/federation/peer-mail/peer-mail-waiters'
import { structuredMailMessage } from '../../../../orchestration/mailbox/structured-mail/structured-mail-source'
import { OrcaRuntimeRpcServer } from '../../../server/runtime-rpc'
import { STATUS_METHODS } from '../../host-management/status'
import { TERMINAL_QUERY_METHODS } from '../../terminal/terminal-query-methods'

// Retries run at once so a recovering pull loop is observable without waiting out its backoff.
vi.mock(
  '../../../../orchestration/federation/relay/federation-relay-scheduler',
  async (original) => ({
    ...(await original<object>()),
    federationRelayRetryDelayMs: () => 0
  })
)

const A_PANE = 'tab_a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B_PANE = 'tab_b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CHAT_ON_A = 'orca_session_id:11111111-1111-4111-8111-111111111111'
const CHAT_ON_B = 'orca_session_id:22222222-2222-4222-8222-222222222222'

type Side = { db: OrchestrationDb; runtime: OrcaRuntimeService; dispatcher: RpcDispatcher }

describe('agent mail between paired Orca servers', () => {
  let dir: string
  let a: Side
  let b: Side
  let bCapabilities: (capabilities: string[]) => string[]
  let bClientKind: 'runtime' | 'mobile'
  let aCredential: string
  let hasEnvironment: () => boolean
  const cliServers = new Map<Side, OrcaRuntimeRpcServer>()

  async function cli(side: Side, ...args: string[]) {
    for (const name of [
      'AGENT_SESSION_ID',
      'TERMINAL_HANDLE',
      'PANE_KEY',
      'PAIRING_CODE',
      'REMOTE_PAIRING',
      'ENVIRONMENT',
      'AGENT_LAUNCH_TOKEN'
    ]) {
      vi.stubEnv(`ORCA_${name}`, '')
    }
    for (const name of ['ID', 'INCARNATION', 'PROFILE_PATH']) {
      vi.stubEnv(`ORCA_RUNTIME_SOURCE_${name}`, '')
    }
    const userDataPath = join(dir, side === a ? 'cli-a' : 'cli-b')
    vi.stubEnv('ORCA_USER_DATA_PATH', userDataPath)
    if (!cliServers.has(side)) {
      mkdirSync(userDataPath, { recursive: true })
      const server = new OrcaRuntimeRpcServer({
        runtime: side.runtime,
        userDataPath,
        methods: [...STATUS_METHODS, ...TERMINAL_QUERY_METHODS, ...ORCHESTRATION_METHODS]
      })
      await server.start()
      cliServers.set(side, server)
    }
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = 0
    try {
      const cliPath = '../../../../../../cli/index'
      const { main } = await import(cliPath)
      await main(['orchestration', ...args, '--json', '--full'])
      const last: unknown = logs.mock.lastCall?.[0]
      return typeof last === 'string' ? JSON.parse(last) : undefined
    } finally {
      logs.mockRestore()
      process.exitCode = 0
    }
  }

  function openSide(name: string, machine: string, transport?: OrchestrationEnvironmentTransport) {
    const db = new OrchestrationDb(join(dir, `${name}.db`))
    const runtime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    vi.spyOn(runtime, 'readMachineName').mockReturnValue(machine)
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
    const panes: Record<string, string> = { term_a: A_PANE, term_b: B_PANE }
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation(
      (handle) => panes[handle] ?? null
    )
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => panes[handle] ?? null)
    runtime.setOrchestrationDb(db)
    return {
      db,
      runtime,
      dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    }
  }

  const transport: OrchestrationEnvironmentTransport = {
    resolve: () => ({
      environmentId: 'env_b',
      name: 'devB',
      peerFingerprint: 'fingerprint_b',
      homePeerFingerprint: aCredential
    }),
    hasEnvironment: () => hasEnvironment(),
    call: async (_selector, method, params) => {
      if (method === 'status.get') {
        const status = b.runtime.getStatus()
        return {
          id: 'status',
          ok: true,
          result: { ...status, capabilities: bCapabilities(status.capabilities ?? []) },
          _meta: { runtimeId: b.runtime.getRuntimeId() }
        }
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
          authenticatedCallerFingerprint: aCredential,
          pairedDeviceId: 'device_a',
          clientKind: bClientKind
        }
      )) as RuntimeRpcResponse<unknown>
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-peer-mail-'))
    bCapabilities = (capabilities) => capabilities
    bClientKind = 'runtime'
    aCredential = 'fingerprint_a'
    hasEnvironment = () => true
    b = openSide('b', 'Build Box')
    a = openSide('a', "Jinwoo's Mac", transport)
  })

  afterEach(async () => {
    setStructuredAgentSessionHost(null)
    for (const server of cliServers.values()) {
      await server.stop()
    }
    cliServers.clear()
    a.runtime.stopOrchestrationFederationRelay()
    b.runtime.stopOrchestrationFederationRelay()
    a.db.close()
    b.db.close()
    rmSync(dir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  let requestCount = 0
  function mutation(side: Side, method: string, params: Record<string, unknown>) {
    requestCount += 1
    return side.dispatcher.dispatch({
      id: `${method}_${requestCount}`,
      authToken: 'local',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `request_${requestCount}`,
      method,
      params
    })
  }

  function chatReply(side: Side, caller: string, params: { id: string; body: string }) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    const orchestrationCaller = {
      address: caller,
      terminalHandle: null,
      orcaSessionId: caller.slice('orca_session_id:'.length),
      paneKey: null
    } as unknown as OrchestrationSessionCaller
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    return ORCHESTRATION_REPLY_METHOD.handler(params, {
      runtime: side.runtime,
      orchestrationCaller
    } as RpcContext)
  }

  function mailFor(side: Side, handle: string) {
    return side.db.getUnreadMessages(handle)
  }

  function receivingBotHome(held = false): string[] {
    const sessionId = CHAT_ON_B.slice('orca_session_id:'.length)
    const bot = makeTestBot({ name: 'Docs', agent: 'claude', chatSessionId: sessionId })
    const saved = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
    const record = agentSessionConversationView({
      ...saved,
      location: { ...saved.location, workspaceId: folderWorkspaceKey(bot.folderWorkspaceId) }
    })
    const notes: string[] = []
    const host = {
      deps: {
        store: {
          getConversation: (id: string) => (id === sessionId ? record : null),
          listConversations: () => [record]
        }
      },
      conversation: async () => ({
        journal: { queuedMessages: { failureHolds: async () => held } }
      }),
      captureAgentStartDestination: async (id: string) => id,
      appendAgentStart: async (_destination: string, line: { body: { text: string } }) => {
        notes.push(line.body.text)
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements the native host calls Home admission and journal notes use.
    setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
    vi.spyOn(b.runtime.bots, 'list').mockReturnValue([bot])
    vi.spyOn(b.runtime.bots, 'enabled').mockReturnValue(true)
    vi.spyOn(b.runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    vi.spyOn(b.runtime, 'publishStructuredAgentSessionTab').mockResolvedValue()
    vi.spyOn(b.runtime, 'notifyMessageArrived').mockImplementation(() => {})
    return notes
  }

  async function requestFromPeer(sender: PeerMailSender | undefined, machine: string) {
    const { conversation_id } = a.db.openHomePeerMailConversation({
      environmentId: 'env_b',
      peerFingerprint: 'fingerprint_b',
      localParty: CHAT_ON_A,
      localPaneKey: null
    })
    const result = await transport.call('devB', 'orchestration.peerMailDeliver', {
      conversationId: conversation_id,
      messageId: 'msg_aaaaaaaaaaaa',
      to: 'bot:Docs',
      senderLabel: `${CHAT_ON_A} on ${machine}`,
      subject: 'Review the sidebar',
      type: 'question',
      sender
    })
    expect(result).toMatchObject({ ok: true })
    const messages = mailFor(b, CHAT_ON_B)
    expect(messages).toHaveLength(1)
    const message = messages[0]!
    const { body } = structuredMailMessage({
      db: b.db,
      mailboxHandle: CHAT_ON_B,
      dispatchId: null,
      message,
      cliCommand: 'orca',
      senderSnapshot: () => ({ name: null, agent: null }),
      followUp: undefined
    })
    return {
      message,
      record: JSON.parse(b.db.getBotRequest(message.id)!.record),
      requestSender: JSON.parse(message.payload!).botRequest.from,
      header: body.blocks.find((block) => block.type === 'text')?.text.split('\n')[0]
    }
  }

  it('keeps a paired bot name in a Home request and routes its answer back', async () => {
    const notes = receivingBotHome()
    const { message, record, requestSender, header } = await requestFromPeer(
      {
        name: 'Sidebar',
        computer: 'Review Laptop',
        bot: { id: 'remote', name: 'Ranger', avatar: null }
      },
      // The label's computer differs: the sender's own record of where it is decides.
      'Laptop (old name)'
    )
    expect(record).toMatchObject({
      fromBotId: null,
      fromBotName: 'Ranger',
      fromPairedComputer: 'Review Laptop',
      askers: [{ kind: 'owner' }]
    })
    expect(requestSender).toBe('Ranger on Review Laptop')
    expect(header).toBe('──── From: Ranger on Review Laptop (question) ────')
    expect(notes).toEqual([])
    await chatReply(b, CHAT_ON_B, { id: message.id, body: 'Looks good.' })
    a.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() =>
      expect(mailFor(a, CHAT_ON_A)).toMatchObject([{ body: 'Looks good.', to_handle: CHAT_ON_A }])
    )
  })

  it.each([
    {
      sender: { name: 'Sidebar', computer: "Morgan's MacBook Pro" },
      description: 'a paired agent'
    },
    { sender: undefined, description: 'an older peer' }
  ])('identifies $description whose request queues in failed Home', async ({ sender }) => {
    const notes = receivingBotHome(true)
    const { record, requestSender, header } = await requestFromPeer(sender, "Morgan's MacBook Pro")
    expect(record).toMatchObject({
      fromBotId: null,
      fromBotName: null,
      fromPairedComputer: "Morgan's MacBook Pro"
    })
    expect(requestSender).toBe("an agent on Morgan's MacBook Pro")
    expect(header).toBe("──── From: an agent on Morgan's MacBook Pro (question) ────")
    expect(notes).toEqual([])
  })

  it('keeps local replies in the original thread with a stable subject', async () => {
    const opened = await cli(
      a,
      'send',
      '--from',
      'term_a',
      '--to',
      'term_b',
      '--subject',
      'Check the build'
    )
    expect(opened).toMatchObject({ result: { message: { to: 'term_b' } } })
    const [original] = mailFor(a, 'term_b')
    await cli(a, 'reply', '--id', original!.id, '--body', 'Green.', '--from', 'term_b')
    const [reply] = mailFor(a, 'term_a')
    await cli(a, 'reply', '--id', reply!.id, '--body', 'Re: Thanks.', '--from', 'term_a')
    const [followup] = mailFor(a, 'term_b')
    expect(followup).toMatchObject({
      subject: 'Re: Check the build',
      body: 'Re: Thanks.',
      thread_id: original!.id
    })
  })

  it('carries a terminal agent mail to the paired server and its flagless reply back', async () => {
    const sent = await cli(
      a,
      'send',
      '--from',
      'term_a',
      '--on',
      'devB',
      '--to',
      'term_b',
      '--subject',
      'Check the build',
      '--type',
      'question',
      '--body',
      'Is main green?'
    )
    expect(sent).toMatchObject({ result: { server: 'devB', message: { to: 'term_b' } } })

    const [onB] = mailFor(b, 'term_b')
    expect(onB).toMatchObject({
      from_handle: "term_a on Jinwoo's Mac",
      subject: 'Check the build',
      type: 'question'
    })

    const replied = await cli(b, 'reply', '--id', onB!.id, '--body', 'Green.', '--from', 'term_b')
    expect(replied).toMatchObject({
      result: { message: { subject: 'Re: Check the build' } }
    })

    a.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(mailFor(a, 'term_a')).toHaveLength(1))
    const [back] = mailFor(a, 'term_a')
    expect(back).toMatchObject({
      from_handle: 'term_b on Build Box',
      subject: 'Re: Check the build',
      body: 'Green.',
      thread_id: onB!.id
    })

    await expect(
      mutation(a, 'orchestration.reply', { id: back!.id, body: 'x', from: 'term_a', on: 'devB' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'request_mismatch' } })

    // The opener can keep answering, and the reply reaches the same agent again.
    await expect(
      mutation(a, 'orchestration.reply', { id: back!.id, body: 'Thanks.', from: 'term_a' })
    ).resolves.toMatchObject({ ok: true })
    expect(mailFor(b, 'term_b').map((message) => message.body)).toEqual(['Thanks.'])
  })

  it("reports the server's delivery hold, as a local send does", async () => {
    // A terminal whose agent died shows no live status, so its server's gate holds the mail.
    vi.spyOn(b.runtime, 'readTerminalMailHold').mockImplementation((mailbox) =>
      mailbox === 'term_b' ? { kind: 'unverified', terminal: 'term_b' } : null
    )

    const sent = await cli(
      a,
      'send',
      '--from',
      'term_a',
      '--on',
      'devB',
      '--to',
      'term_b',
      '--subject',
      'Still there?'
    )

    expect(sent).toMatchObject({
      result: { warnings: [{ code: 'recipient_delivery_held', recipient: 'term_b' }] }
    })
    expect(mailFor(b, 'term_b')).toHaveLength(1)
  })

  it('returns a chat agent reply to the chat on the opening server', async () => {
    const send = ORCHESTRATION_METHODS.find((method) => method.name === 'orchestration.send')!
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
    await send.handler({ from: CHAT_ON_A, on: 'devB', to: 'term_b', subject: 'Plan?' }, {
      runtime: a.runtime,
      orchestrationCaller: {
        address: CHAT_ON_A,
        terminalHandle: null,
        orcaSessionId: CHAT_ON_A.slice(16),
        paneKey: null
      }
    } as unknown as RpcContext)
    const [onB] = mailFor(b, 'term_b')
    expect(onB!.from_handle).toBe(`${CHAT_ON_A} on Jinwoo's Mac`)

    await chatReply(b, CHAT_ON_B, { id: onB!.id, body: 'Plan attached.' })

    a.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(mailFor(a, CHAT_ON_A)).toHaveLength(1))
    expect(mailFor(a, CHAT_ON_A)[0]).toMatchObject({
      from_handle: `${CHAT_ON_B} on Build Box`,
      body: 'Plan attached.'
    })
    expect(a.db.getPeerMailMessage(mailFor(a, CHAT_ON_A)[0]!.id)?.remote_party).toBe(CHAT_ON_B)
  })

  it('delivers a reply queued before both servers restart exactly once', async () => {
    await mutation(a, 'orchestration.send', {
      from: 'term_a',
      on: 'devB',
      to: 'term_b',
      subject: 'Long job'
    })
    const [onB] = mailFor(b, 'term_b')
    await mutation(b, 'orchestration.reply', { id: onB!.id, body: 'Done.', from: 'term_b' })

    a.runtime.stopOrchestrationFederationRelay()
    a.db.close()
    b.db.close()
    b = openSide('b', 'Build Box')
    a = openSide('a', "Jinwoo's Mac", transport)

    a.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(mailFor(a, 'term_a')).toHaveLength(1))
    expect(b.db.listPeerConversationIdsWithPendingReplies('fingerprint_a')).toEqual([])
  })

  it('refuses an older server before sending anything', async () => {
    bCapabilities = (capabilities) =>
      capabilities.filter((capability) => capability !== ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY)

    const sent = await mutation(a, 'orchestration.send', {
      from: 'term_a',
      on: 'devB',
      to: 'term_b',
      subject: 'Hello'
    })

    expect(sent).toMatchObject({
      ok: false,
      error: { code: 'server_mail_unsupported', data: { effectsApplied: false } }
    })
    expect(b.db.getInbox(10)).toEqual([])
  })

  it('takes mail between servers only from a paired computer, not a phone', async () => {
    bClientKind = 'mobile'

    const sent = await mutation(a, 'orchestration.send', {
      from: 'term_a',
      on: 'devB',
      to: 'term_b',
      subject: 'Hello'
    })

    expect(sent).toMatchObject({
      ok: false,
      error: { code: 'mail_requires_server_pairing' }
    })
    expect(b.db.getInbox(10)).toEqual([])
  })

  it.each(['dispatch', 'merge_ready'])('carries ordinary %s mail unchanged', async (type) => {
    const sent = await mutation(a, 'orchestration.send', {
      from: 'term_a',
      on: 'devB',
      to: 'term_b',
      subject: 'Next step',
      type
    })
    expect(sent).toMatchObject({ ok: true })
    expect(mailFor(b, 'term_b')).toMatchObject([{ subject: 'Next step', type }])
  })

  it('replays a peer mail send without delivering it twice', async () => {
    const request = {
      id: 'send_once',
      authToken: 'local',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'peer_send_once',
      method: 'orchestration.send',
      params: {
        from: 'term_a',
        on: 'devB',
        to: 'term_b',
        subject: 'Only this server',
        type: 'question'
      }
    }
    expect(await a.dispatcher.dispatch(request)).toMatchObject({ ok: true })
    expect(await a.dispatcher.dispatch(request)).toMatchObject({ ok: true })
    expect(mailFor(b, 'term_b')).toMatchObject([{ subject: 'Only this server', type: 'question' }])
  })

  it('keeps question-capable peers working without five-type support', async () => {
    bCapabilities = (capabilities) =>
      capabilities.filter(
        (capability) => capability !== ORCHESTRATION_PEER_MAIL_TYPES_RUNTIME_CAPABILITY
      )
    expect(
      await mutation(a, 'orchestration.send', {
        from: 'term_a',
        on: 'devB',
        to: 'term_b',
        subject: 'Question',
        type: 'question'
      })
    ).toMatchObject({ ok: true })
    expect(mailFor(b, 'term_b')).toMatchObject([{ type: 'question' }])
    expect(
      await mutation(a, 'orchestration.send', {
        from: 'term_a',
        on: 'devB',
        to: 'term_b',
        subject: 'Dispatch',
        type: 'dispatch'
      })
    ).toMatchObject({ ok: false, error: { code: 'server_mail_unsupported' } })
    expect(mailFor(b, 'term_b')).toHaveLength(1)
  })

  it('refuses new types on an old enum peer while keeping its status mail working', async () => {
    bCapabilities = (capabilities) =>
      capabilities.filter(
        (capability) =>
          capability !== ORCHESTRATION_PEER_MAIL_TYPES_RUNTIME_CAPABILITY &&
          capability !== ORCHESTRATION_PEER_BOT_MAIL_RUNTIME_CAPABILITY
      )
    const sent = await cli(
      a,
      'send',
      '--from',
      'term_a',
      '--on',
      'devB',
      '--to',
      'term_b',
      '--subject',
      'Question',
      '--type',
      'question'
    )
    expect(sent).toMatchObject({
      error: { code: 'server_mail_unsupported', data: { effectsApplied: false } }
    })
    expect(b.db.getInbox(10)).toEqual([])
    expect(
      await mutation(a, 'orchestration.send', {
        from: 'term_a',
        on: 'devB',
        to: 'term_b',
        subject: 'Status',
        type: 'status'
      })
    ).toMatchObject({ ok: true })
    expect(mailFor(b, 'term_b')).toMatchObject([{ subject: 'Status', type: 'status' }])
  })

  it('acknowledges a retried delivery after its recipient is gone, storing it once', async () => {
    const deliver = {
      conversationId: 'peerconv_aaaaaaaaaaaa',
      messageId: 'msg_aaaaaaaaaaaa',
      to: 'term_b',
      senderLabel: "term_a on Jinwoo's Mac",
      subject: 'Once'
    }
    const first = await transport.call('devB', 'orchestration.peerMailDeliver', deliver)
    vi.mocked(b.runtime.getLiveTerminalPaneKey).mockReturnValue(null)

    const retried = await transport.call('devB', 'orchestration.peerMailDeliver', deliver)

    expect(first).toMatchObject({ ok: true })
    expect(retried).toMatchObject({ ok: true, result: { message: { id: 'msg_aaaaaaaaaaaa' } } })
    expect(b.db.getInbox(10).filter((message) => message.subject === 'Once')).toHaveLength(1)
  })

  it('refuses mail to a worker another Orca coordinates', async () => {
    vi.spyOn(b.db, 'findActiveRemoteAttachmentForPane').mockImplementation((paneKey) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying only the fields the code under test reads.
      paneKey === B_PANE ? ({ dispatch_id: 'ctx_remote' } as never) : undefined
    )

    const sent = await mutation(a, 'orchestration.send', {
      from: 'term_a',
      on: 'devB',
      to: 'term_b',
      subject: 'Side mail'
    })

    expect(sent).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(b.db.getInbox(10)).toEqual([])
  })

  it('keeps conversing with a server after it is re-paired', async () => {
    await mutation(a, 'orchestration.send', {
      from: 'term_a',
      on: 'devB',
      to: 'term_b',
      subject: 'First'
    })
    const [first] = mailFor(b, 'term_b')
    await mutation(b, 'orchestration.reply', { id: first!.id, body: 'One.', from: 'term_b' })
    a.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(mailFor(a, 'term_a')).toHaveLength(1))
    const [answer] = mailFor(a, 'term_a')
    b.db.markAsRead([first!.id], { kind: 'orca' })

    aCredential = 'fingerprint_a_repaired'
    await expect(
      mutation(a, 'orchestration.send', {
        from: 'term_a',
        on: 'devB',
        to: 'term_b',
        subject: 'Second'
      })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      mutation(a, 'orchestration.reply', { id: answer!.id, body: 'Thanks.', from: 'term_a' })
    ).resolves.toMatchObject({ ok: true })

    expect(mailFor(b, 'term_b').map((message) => message.subject)).toEqual(['Second', 'Re: First'])
  })

  it('acknowledges a reply replayed after this Orca reset its mail', async () => {
    await mutation(a, 'orchestration.send', {
      from: 'term_a',
      on: 'devB',
      to: 'term_b',
      subject: 'Ask'
    })
    const [onB] = mailFor(b, 'term_b')
    await mutation(b, 'orchestration.reply', { id: onB!.id, body: 'Answer.', from: 'term_b' })
    a.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() => expect(mailFor(a, 'term_a')).toHaveLength(1))
    await vi.waitFor(() =>
      expect(b.db.listPeerConversationIdsWithPendingReplies('fingerprint_a')).toEqual([])
    )

    a.db.resetMessages()
    // The ack was lost: the server serves the stored reply again.
    b.db['db'].prepare('UPDATE federation_relay_items SET acked_at = NULL').run()
    notifyPeerMailQueued(b.db.db)

    await vi.waitFor(() =>
      expect(b.db.listPeerConversationIdsWithPendingReplies('fingerprint_a')).toEqual([])
    )
    expect(mailFor(a, 'term_a')).toEqual([])
  })

  it('keeps a queued reply when the server resets its tasks', async () => {
    await mutation(a, 'orchestration.send', {
      from: 'term_a',
      on: 'devB',
      to: 'term_b',
      subject: 'Ask'
    })
    a.runtime.stopOrchestrationFederationRelay()
    const [onB] = mailFor(b, 'term_b')
    await mutation(b, 'orchestration.reply', { id: onB!.id, body: 'Kept.', from: 'term_b' })

    b.db.resetTasks()

    a.runtime.ensureOrchestrationFederationRelay()
    await vi.waitFor(() =>
      expect(mailFor(a, 'term_a').map((message) => message.body)).toEqual(['Kept.'])
    )
  })

  it('keeps pulling after a failed pull when the server list cannot be read', async () => {
    await mutation(a, 'orchestration.send', {
      from: 'term_a',
      on: 'devB',
      to: 'term_b',
      subject: 'Ask'
    })
    a.runtime.stopOrchestrationFederationRelay()
    const [onB] = mailFor(b, 'term_b')
    await mutation(b, 'orchestration.reply', { id: onB!.id, body: 'Later.', from: 'term_b' })
    const call = vi.spyOn(transport, 'call')
    call.mockRejectedValueOnce(new Error('offline'))
    hasEnvironment = () => {
      hasEnvironment = () => true
      throw new Error('registry unreadable')
    }

    a.runtime.ensureOrchestrationFederationRelay()

    await vi.waitFor(() =>
      expect(mailFor(a, 'term_a').map((message) => message.body)).toEqual(['Later.'])
    )
    call.mockRestore()
  })
})
