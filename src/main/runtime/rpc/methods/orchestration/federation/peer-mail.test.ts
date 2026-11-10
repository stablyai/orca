import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/federation/environment-transport'
import type { OrchestrationSessionCaller } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { RpcDispatcher } from '../../../dispatcher'
import type { RpcContext } from '../../../core'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { ORCHESTRATION_REPLY_METHOD } from '../messaging/reply-method'
import { notifyPeerMailQueued } from '../../../../orchestration/federation/peer-mail/peer-mail-waiters'

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

  afterEach(() => {
    a.runtime.stopOrchestrationFederationRelay()
    b.runtime.stopOrchestrationFederationRelay()
    a.db.close()
    b.db.close()
    rmSync(dir, { recursive: true, force: true })
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

  it('carries a terminal agent mail to the paired server and its flagless reply back', async () => {
    const sent = await mutation(a, 'orchestration.send', {
      from: 'term_a',
      on: 'devB',
      to: 'term_b',
      subject: 'Check the build',
      body: 'Is main green?'
    })
    expect(sent).toMatchObject({ ok: true, result: { server: 'devB', message: { to: 'term_b' } } })

    const [onB] = mailFor(b, 'term_b')
    expect(onB).toMatchObject({ from_handle: "term_a on Jinwoo's Mac", subject: 'Check the build' })

    const replied = await mutation(b, 'orchestration.reply', {
      id: onB!.id,
      body: 'Green.',
      from: 'term_b'
    })
    expect(replied).toMatchObject({
      ok: true,
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
    const [conversationId] = b.db.listPeerConversationIds('fingerprint_a')
    expect(b.db.listPendingFederationRelay(conversationId!, 'to_home')).toEqual([])
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
    b.db.markAsRead([first!.id])

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
    const [conversationId] = b.db.listPeerConversationIds('fingerprint_a')
    await vi.waitFor(() =>
      expect(b.db.listPendingFederationRelay(conversationId!, 'to_home')).toEqual([])
    )

    a.db.resetMessages()
    // The ack was lost: the server serves the stored reply again.
    b.db['db'].prepare('UPDATE federation_relay_items SET acked_at = NULL').run()
    notifyPeerMailQueued(b.db.db)

    await vi.waitFor(() =>
      expect(b.db.listPendingFederationRelay(conversationId!, 'to_home')).toEqual([])
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
