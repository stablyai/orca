import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { PeerMailItem } from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { peerMailRelayEnvironments } from '../../../../orchestration/federation/peer-mail/peer-mail-relay-environments'
import { settleRemovedPairedClient } from '../../../../orchestration/federation/client-asks/client-ask-queue'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'

const ASKER_PANE = 'tab_s:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CLIENT = { pairedDeviceId: 'device_a', authenticatedCallerFingerprint: 'fp_a' }

const Pulled = z.object({
  items: z.array(PeerMailItem),
  clientAsks: z.object({ seenAs: z.string() }).optional()
})

describe('agents here messaging agents on a paired computer', () => {
  let dir: string
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let dispatcher: RpcDispatcher
  let count = 0

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-client-asks-'))
    db = new OrchestrationDb(join(dir, 'server.db'))
    runtime = new OrcaRuntimeService(null)
    vi.spyOn(runtime, 'readMachineName').mockReturnValue('Build Box')
    vi.spyOn(runtime, 'getTerminalHandleForPaneKey').mockReturnValue(null)
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_s' ? ASKER_PANE : null
    )
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_s' ? ASKER_PANE : null
    )
    runtime.setOrchestrationDb(db)
    dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function local(method: string, params: Record<string, unknown>) {
    count += 1
    return dispatcher.dispatch({
      id: `${method}_${count}`,
      authToken: 'local',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: `request_${count}`,
      method,
      params
    })
  }

  function fromClient(
    method: string,
    params: Record<string, unknown>,
    options: { signal?: AbortSignal; fingerprint?: string; deviceId?: string } = {}
  ) {
    count += 1
    return dispatcher.dispatch(
      {
        id: `${method}_${count}`,
        authToken: 'client-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        method,
        params
      },
      {
        clientKind: 'runtime',
        pairedDeviceId: options.deviceId ?? CLIENT.pairedDeviceId,
        authenticatedCallerFingerprint:
          options.fingerprint ?? CLIENT.authenticatedCallerFingerprint,
        signal: options.signal
      }
    )
  }

  const asks = (session: string, extra: Record<string, unknown> = {}) => ({
    session,
    installationId: 'install_a',
    name: 'Client A',
    ...extra
  })

  async function pull(session = 'session_1', extra: Record<string, unknown> = {}) {
    const response = await fromClient('orchestration.peerMailPull', {
      waitMs: 0,
      clientAsks: asks(session, extra)
    })
    if (!response.ok) {
      throw new Error(JSON.stringify(response))
    }
    return Pulled.parse(response.result)
  }

  const ask = (params: Record<string, unknown> = {}) =>
    local('orchestration.send', {
      from: 'term_s',
      onClient: 'install_a',
      to: 'bot:Literature',
      subject: 'Check the citations',
      body: 'Are they all real?',
      ...params
    })

  const told = () => db.getAllMessagesForHandle('term_s').map((message) => message.body)

  it('fails at once as offline when the computer is not pulling, and queues nothing', async () => {
    const sent = await ask()

    expect(sent).toMatchObject({
      ok: false,
      error: { code: 'remote_runtime_unavailable', data: { effectsApplied: false } }
    })
    expect(
      db.listPeerConversationIdsWithPendingReplies('fp_a', 'client:device_a/install_a')
    ).toEqual([])
  })

  it('stays listening between answered pulls and hands the ask over once', async () => {
    await pull()
    const sent = await ask({ type: 'question' })
    expect(sent).toMatchObject({
      ok: true,
      result: { client: 'Client A', message: { to: 'bot:Literature' } }
    })

    const { items, clientAsks } = await pull()
    expect(clientAsks).toEqual({ seenAs: 'fp_a' })
    expect(items).toHaveLength(1)
    expect(items[0]!.kind).toBe('client_ask')
    expect(JSON.parse(items[0]!.payload)).toMatchObject({
      to: 'bot:Literature',
      subject: 'Check the citations',
      type: 'question',
      rootSession: 'term_s'
    })

    await fromClient('orchestration.peerMailAck', {
      acknowledgments: [
        { conversationId: items[0]!.conversationId, throughSequence: items[0]!.sequence }
      ]
    })
    expect((await pull()).items).toEqual([])
  })

  it('goes offline when a pull ends because the computer went away, but not for an older session', async () => {
    await pull('session_1')
    const older = new AbortController()
    const waiting = fromClient(
      'orchestration.peerMailPull',
      { waitMs: 20_000, clientAsks: asks('session_1') },
      { signal: older.signal }
    )
    // A reconnect starts a newer session while the older pull still waits.
    await pull('session_2')
    older.abort()
    await waiting
    expect(await ask()).toMatchObject({ ok: true })

    const current = new AbortController()
    const pending = fromClient(
      'orchestration.peerMailPull',
      { waitMs: 20_000, clientAsks: asks('session_2') },
      { signal: current.signal }
    )
    current.abort()
    await pending
    expect(await ask()).toMatchObject({ ok: false, error: { code: 'remote_runtime_unavailable' } })
  })

  it('settles a question by the request id the computer returns, and a later removal tells no one', async () => {
    await pull()
    await ask({ type: 'question' })
    const [item] = (await pull()).items
    const returned = await fromClient('orchestration.peerMailReturn', {
      items: [
        {
          conversationId: item!.conversationId,
          sequence: 1,
          messageId: 'msg_notice_1',
          kind: 'peer_mail',
          payload: JSON.stringify({
            senderLabel: 'Literature on Client A',
            fromAddress: 'bot:Literature',
            subject: 'Re: Check the citations',
            body: 'Declined on Client A.',
            threadId: item!.messageId,
            notice: { requestId: item!.messageId }
          })
        }
      ]
    })
    expect(returned).toMatchObject({
      ok: true,
      result: {
        acknowledgments: [{ conversationId: item!.conversationId, throughSequence: 1 }],
        gone: []
      }
    })

    settleRemovedPairedClient(runtime, { deviceId: 'device_a', name: 'Client A' })

    expect(told()).toEqual(['Declined on Client A.'])
  })

  it('tells a waiting asker once when the computer is removed, and it stops listening', async () => {
    await pull()
    await ask({ type: 'question' })

    settleRemovedPairedClient(runtime, { deviceId: 'device_a', name: 'Client A' })
    settleRemovedPairedClient(runtime, { deviceId: 'device_a', name: 'Client A' })

    expect(told()).toHaveLength(1)
    expect(told()[0]).toMatch(
      /^Client A was removed from this Orca's paired computers\. Your question msg_/
    )
    expect(await ask()).toMatchObject({ ok: false, error: { code: 'remote_runtime_unavailable' } })
  })

  it('on a re-pair, tells only askers of the pairing the computer names, not a copy sharing its id', async () => {
    await pull()
    await ask({ type: 'question' })
    // A second computer carrying a copied installation id pulls under its own pairing.
    await fromClient(
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: asks('copy_session') },
      { deviceId: 'device_copy', fingerprint: 'fp_copy' }
    )
    expect(told()).toEqual([])

    await fromClient(
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: asks('session_new', { previousPairing: 'fp_a' }) },
      { deviceId: 'device_a2', fingerprint: 'fp_a2' }
    )

    expect(told()).toHaveLength(1)
    expect(told()[0]).toMatch(/^The pairing with Client A was re-made\./)
  })

  it('queues a reply to the computer agent as a reply, not a new ask', async () => {
    await pull()
    await ask({ type: 'question' })
    const [item] = (await pull()).items
    await fromClient('orchestration.peerMailReturn', {
      items: [
        {
          conversationId: item!.conversationId,
          sequence: 1,
          messageId: 'msg_answer_1',
          kind: 'peer_mail',
          payload: JSON.stringify({
            senderLabel: 'Literature on Client A',
            fromAddress: 'bot:Literature',
            subject: 'Re: Check the citations',
            body: 'All real.',
            threadId: item!.messageId
          })
        }
      ]
    })
    const [answer] = db.getUnreadMessages('term_s')

    const replied = await local('orchestration.reply', {
      id: answer!.id,
      body: 'Thanks.',
      from: 'term_s'
    })

    expect(replied).toMatchObject({ ok: true })
    const items = (await pull()).items.filter((queued) => queued.messageId !== item!.messageId)
    expect(items.map((queued) => queued.kind)).toEqual(['client_reply'])
    expect(JSON.parse(items[0]!.payload)).toMatchObject({ to: 'bot:Literature', body: 'Thanks.' })
  })

  it('never starts a pull loop toward a paired computer', async () => {
    await pull()
    await ask()

    expect([...peerMailRelayEnvironments(db)]).toEqual([])
    expect(db.listHomePeerMailEnvironments()).toEqual([])
  })
})
