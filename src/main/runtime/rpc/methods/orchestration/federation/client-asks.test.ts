import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { PeerMailItem } from '../../../../../../shared/rpc-contract/orchestration/orchestration-peer-mail-params'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import {
  peerMailRelayEnvironments,
  peerMailRelayWants
} from '../../../../orchestration/federation/peer-mail/peer-mail-relay-environments'
import {
  recordRemovedPairedClient,
  replayUnsettledClientPairingEnds,
  settleRemovedPairedClient,
  withdrawClientAsksOf
} from '../../../../orchestration/federation/client-asks/client-ask-queue'
import { registerPairedDeviceCredentials } from '../../../../orchestration/federation/client-asks/client-ask-ended-pairings'
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
    startRuntime()
  })

  /** This Orca, started on the database; again, as after a restart, it keeps nothing from memory. */
  function startRuntime() {
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
  }

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

  // The computer's pull ends because it went away.
  function settleOffline() {
    const gone = new AbortController()
    gone.abort()
    return fromClient(
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: asks('session_1') },
      { signal: gone.signal }
    )
  }

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

  it('finishes a removal interrupted before its askers were told at the next start, once, and leaves a registered computer alone', async () => {
    await pull()
    await ask({ type: 'question', subject: 'Removed computer' })
    const other = { deviceId: 'device_b', fingerprint: 'fp_b' }
    await fromClient(
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: asks('session_b', { installationId: 'install_b' }) },
      other
    )
    await ask({ type: 'question', subject: 'Offline computer', onClient: 'install_b' })
    // Both ends were recorded before their revoke; only device_a's revoke happened. Telling its
    // asker fails part way (after the notice, before the queue is dropped), as a crash would.
    recordRemovedPairedClient(runtime, { deviceId: 'device_a', name: 'Client A' })
    recordRemovedPairedClient(runtime, { deviceId: 'device_b', name: 'Client B' })
    const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementationOnce(() => {
      throw new Error('interrupted')
    })
    settleRemovedPairedClient(runtime, { deviceId: 'device_a', name: 'Client A' })
    notify.mockRestore()
    expect(told()).toHaveLength(1)

    startRuntime()
    const registry = new Map([['device_b', 'fp_b']])
    registerPairedDeviceCredentials(runtime, (deviceId) => registry.get(deviceId) ?? null)
    replayUnsettledClientPairingEnds(runtime)
    replayUnsettledClientPairingEnds(runtime)

    expect(told()).toHaveLength(1)
    expect(told()[0]).toMatch(/^Client A was removed from this Orca's paired computers\./)
    const unsettled = db.db
      .prepare('SELECT environment_id FROM ended_client_pairings WHERE settled_at IS NULL')
      .all()
    // The registered computer's end waits: its revoke never happened, and its next pull revives it.
    expect(unsettled).toEqual([{ environment_id: 'client:device_b/install_b' }])
    const queued = db.db
      .prepare(
        `SELECT c.environment_id FROM federation_relay_items i
         JOIN peer_mail_conversations c ON c.conversation_id = i.dispatch_id
         WHERE i.direction = 'to_worker' AND i.acked_at IS NULL`
      )
      .all()
    expect(queued).toEqual([{ environment_id: 'client:device_b/install_b' }])
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

  it('on a re-pair that keeps its device, tells only questions of the older pairing', async () => {
    await pull()
    await ask({ type: 'question' })
    const repaired = { deviceId: 'device_a', fingerprint: 'fp_a2' }
    await fromClient(
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: asks('session_2') },
      repaired
    )
    await ask({ type: 'question', subject: 'Second question' })

    await fromClient(
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: asks('session_3', { previousPairing: 'fp_a' }) },
      repaired
    )

    expect(told()).toHaveLength(1)
    const pending = await fromClient(
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: asks('session_3') },
      repaired
    )
    expect(
      Pulled.parse(pending.ok ? pending.result : null).items.map(
        (item) => JSON.parse(item.payload).subject
      )
    ).toEqual(['Second question'])
  })

  /** A question to the computer's agent, answered there; its answer is unread here. */
  async function answeredQuestion(answerId: string) {
    await pull()
    await ask({ type: 'question' })
    const [item] = (await pull()).items
    await fromClient('orchestration.peerMailReturn', {
      items: [
        {
          conversationId: item!.conversationId,
          sequence: 1,
          messageId: answerId,
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
    return { item: item!, answer: db.getUnreadMessages('term_s')[0]! }
  }

  const reply = (id: string) =>
    local('orchestration.reply', { id, body: 'Thanks.', from: 'term_s' })

  it('refuses a reply on a conversation whose pairing was re-made, after a restart too, and queues none', async () => {
    const { answer } = await answeredQuestion('msg_answer_2')
    const repaired = { deviceId: 'device_a2', fingerprint: 'fp_a2' }
    const pullRepaired = (session: string, extra: Record<string, unknown> = {}) =>
      fromClient(
        'orchestration.peerMailPull',
        { waitMs: 0, clientAsks: asks(session, extra) },
        repaired
      )
    await pullRepaired('session_2', { previousPairing: 'fp_a' })

    const refused = await reply(answer.id)
    startRuntime()
    await pullRepaired('session_3')
    const refusedAfterRestart = await reply(answer.id)

    expect(refused).toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    expect(refusedAfterRestart).toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    const pulled = await pullRepaired('session_3')
    expect(Pulled.parse(pulled.ok ? pulled.result : null).items).toEqual([])
  })

  it('tells the replier once when a reply waiting for the offline computer is lost to its re-pair', async () => {
    const { answer } = await answeredQuestion('msg_answer_5')
    await settleOffline()
    expect(await reply(answer.id)).toMatchObject({ ok: true })
    const repaired = { deviceId: 'device_a2', fingerprint: 'fp_a2' }

    // The re-pair is announced until the server answers it, so it may come twice.
    const announce = (session: string) =>
      fromClient(
        'orchestration.peerMailPull',
        { waitMs: 0, clientAsks: asks(session, { previousPairing: 'fp_a' }) },
        repaired
      )
    await announce('session_2')
    await announce('session_3')

    const lost = told().filter((body) => body.includes('never confirmed as taken'))
    expect(lost).toHaveLength(1)
    expect(lost[0]).toMatch(
      /^The pairing with Client A was re-made\. Your reply msg_\w+ there was never confirmed as taken, and it will not be sent again\.$/
    )
  })

  it('on a re-pair, ends only the pairing it names: another this device still pulls with keeps its mail', async () => {
    await pull()
    await ask({ type: 'question', subject: 'First pairing' })
    const second = { deviceId: 'device_a', fingerprint: 'fp_b' }
    await fromClient(
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: asks('session_b') },
      second
    )
    await ask({ type: 'question', subject: 'Second pairing' })

    await fromClient(
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: asks('session_c', { previousPairing: 'fp_a' }) },
      { deviceId: 'device_a', fingerprint: 'fp_c' }
    )

    expect(told()).toHaveLength(1)
    const kept = await fromClient(
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: asks('session_b') },
      second
    )
    expect(
      Pulled.parse(kept.ok ? kept.result : null).items.map(
        (item) => JSON.parse(item.payload).subject
      )
    ).toEqual(['Second pairing'])
  })

  it('keeps a pairing that still pulls, whatever re-pair another computer claims for it', async () => {
    const { item, answer } = await answeredQuestion('msg_answer_6')
    await fromClient(
      'orchestration.peerMailPull',
      { waitMs: 0, clientAsks: asks('copy_session', { previousPairing: 'fp_a' }) },
      { deviceId: 'device_copy', fingerprint: 'fp_copy' }
    )
    // The computer pulls again under its own credential.
    await pull('session_back')

    expect(await reply(answer.id)).toMatchObject({ ok: true })
    const items = (await pull('session_back')).items.filter(
      (queued) => queued.messageId !== item.messageId
    )
    expect(items.map((queued) => queued.kind)).toEqual(['client_reply'])
  })

  it('queues a reply while the computer is offline, for its next pull', async () => {
    await pull()
    await ask({ type: 'question' })
    const [item] = (await pull()).items
    await fromClient('orchestration.peerMailReturn', {
      items: [
        {
          conversationId: item!.conversationId,
          sequence: 1,
          messageId: 'msg_answer_3',
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
    await settleOffline()

    const replied = await local('orchestration.reply', {
      id: answer!.id,
      body: 'Thanks.',
      from: 'term_s'
    })

    expect(replied).toMatchObject({ ok: true })
    const items = (await pull('session_back')).items.filter(
      (queued) => queued.messageId !== item!.messageId
    )
    expect(items.map((queued) => queued.kind)).toEqual(['client_reply'])
  })

  it('keeps a reply for the offline computer, never a copy sharing its installation id', async () => {
    await pull()
    await ask({ type: 'question' })
    const [item] = (await pull()).items
    await fromClient('orchestration.peerMailReturn', {
      items: [
        {
          conversationId: item!.conversationId,
          sequence: 1,
          messageId: 'msg_answer_4',
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
    await settleOffline()
    const copy = { deviceId: 'device_copy', fingerprint: 'fp_copy' }
    const copyPull = () =>
      fromClient('orchestration.peerMailPull', { waitMs: 0, clientAsks: asks('copy') }, copy)
    await copyPull()

    await local('orchestration.reply', { id: answer!.id, body: 'Thanks.', from: 'term_s' })

    const copied = await copyPull()
    expect(Pulled.parse(copied.ok ? copied.result : null).items).toEqual([])
    const items = (await pull('session_back')).items.filter(
      (queued) => queued.messageId !== item!.messageId
    )
    expect(items.map((queued) => queued.kind)).toEqual(['client_reply'])
  })

  it('refuses an empty computer instead of sending the mail here', async () => {
    const sent = await ask({ onClient: '' })

    expect(sent).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(db.getInbox(10)).toEqual([])
  })

  it("withdraws a deleted chat's asks: drops the one not taken yet, withdraws the one taken", async () => {
    await pull()
    await ask({ type: 'question' })
    const [taken] = (await pull()).items
    await fromClient('orchestration.peerMailAck', {
      acknowledgments: [{ conversationId: taken!.conversationId, throughSequence: taken!.sequence }]
    })
    await ask({ type: 'question', subject: 'Not taken yet' })

    withdrawClientAsksOf(runtime, ['term_s'])

    const items = (await pull()).items
    expect(items.map((item) => [item.kind, JSON.parse(item.payload)])).toEqual([
      ['client_ask_withdraw', { requestId: taken!.messageId }]
    ])
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM peer_questions_out').get()).toEqual({ n: 0 })
  })

  it('never starts a pull loop toward a paired computer', async () => {
    await pull()
    await ask()

    expect([...peerMailRelayEnvironments(db)]).toEqual([])
    expect(db.listHomePeerMailEnvironments()).toEqual([])
    expect(peerMailRelayWants(db, 'client:device_a/install_a')).toBe(false)
  })
})
