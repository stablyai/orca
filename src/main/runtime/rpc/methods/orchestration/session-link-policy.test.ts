import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { SessionLinkStore } from '../../../orchestration/session-links/session-link-store'
import { sessionLinkTestParticipants as participants } from '../../../orchestration/session-links/session-link-test-fixture'
import { SESSION_LINK_METHODS } from './session-link-methods'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { sessionLinkSendReceipt } from '../../../../../shared/session-link-receipt'
import { sessionLinkNextMessage } from '../../../../../shared/session-link-wait'
import {
  peerCoordinatorCaller,
  type OrchestrationSessionCaller
} from '../../../orchestration/addressing/orchestration-caller-identity'

vi.mock('../../../orchestration/session-links/session-link-delivery', () => ({
  redriveSessionLinks: vi.fn(async () => {}),
  scheduleSessionLinkDelivery: vi.fn()
}))
vi.mock('../../../orchestration/session-links/session-link-participants', async () => {
  const { sessionLinkTestParticipants } =
    await import('../../../orchestration/session-links/session-link-test-fixture')
  return { sessionLinkCandidates: vi.fn(async () => sessionLinkTestParticipants) }
})
vi.mock('../../../orchestration/session-links/session-link-stop', () => ({
  stopSessionLinkTurns: vi.fn()
}))

describe('owner-controlled collaboration policy', () => {
  let db: OrchestrationDb
  let store: SessionLinkStore
  let owner: RpcContext
  let agent: RpcContext & { orchestrationCaller: OrchestrationSessionCaller }
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    store = new SessionLinkStore(db)
    store.create('link', 'Synthetic local review', participants)
    owner = { runtime, caller: { kind: 'desktop' } }
    agent = {
      runtime,
      caller: { kind: 'local-cli' },
      orchestrationCaller: {
        address: 'orca_session_id:codex_implement',
        terminalHandle: null,
        paneKey: null,
        orcaSessionId: testOrcaSessionId('codex_implement'),
        sessionId: testOrcaSessionId('codex_implement'),
        workspaceId: 'repo::/work/implement'
      }
    }
  })
  afterEach(() => db.close())
  const call = async (name: string, params: unknown, context = owner) => {
    const method = eraseRpcMethods(SESSION_LINK_METHODS).find(
      (m) => m.name === `orchestration.${name}`
    )
    if (!method) {
      throw new Error('Missing method')
    }
    return method.handler(method.params?.parse(params), context)
  }
  const send = (operationId: string, kind = 'message', body = operationId) =>
    call('linkSend', { id: 'link', operationId, kind, body }, agent)
  const policy = (turnLimit: number | null, resume = false, operationId = 'policy') =>
    call('linkSetPolicy', {
      id: 'link',
      version: store.get('link').version,
      operationId,
      policy: { turnLimit },
      resume
    })
  const answer = (
    operationId: string,
    version: number,
    ownerMessage = 'Continue local checks only. No spending.'
  ) =>
    call('linkControl', {
      id: 'link',
      operationId,
      version,
      action: 'resume',
      ownerMessage
    })

  it('refuses a paired peer coordinator as both a link owner and a participant without effects', async () => {
    const peer = peerCoordinatorCaller(
      db.admitPeerRun({
        peerFingerprint: 'paired-server',
        peerRun: { runId: 'remote-run', conversationId: 'remote-conversation', label: 'Peer' }
      })
    )
    const context: RpcContext = {
      ...owner,
      caller: { kind: 'paired-device', deviceId: 'paired-server' },
      clientKind: 'runtime',
      orchestrationCaller: peer
    }
    const before = store.get('link')
    const events = store.events('link')
    await expect(
      call(
        'linkSetPolicy',
        {
          id: 'link',
          operationId: 'peer-policy',
          version: before.version,
          policy: { turnLimit: null }
        },
        context
      )
    ).rejects.toThrow('is not in the Run Peer coordinates here')
    await expect(
      call(
        'linkSend',
        {
          id: 'link',
          operationId: 'peer-message',
          kind: 'message',
          body: 'Peer message'
        },
        context
      )
    ).rejects.toThrow('is not in the Run Peer coordinates here')
    expect(store.get('link')).toEqual(before)
    expect(store.events('link')).toEqual(events)
  })

  it('runs beyond six wake-ups and twelve messages, while retaining repetition and backlog protection', async () => {
    await policy(null)
    for (let i = 0; i < 20; i++) {
      await send(`report-${i}`)
      const next = sessionLinkNextMessage(store.events('link'), 'claude_review')
      if (!next) {
        throw new Error('Missing report')
      }
      const reserved = store.reserve('link', next.id)
      if (!reserved) {
        throw new Error('Report refused')
      }
      store.write({ ...reserved, state: 'accepted' })
    }
    expect(new SessionLinkStore(db).get('link')).toMatchObject({
      state: 'active',
      turns: 20,
      messages: 20,
      policy: { turnLimit: null }
    })
    for (let i = 0; i < 12; i++) {
      await send(`pending-${i}`)
    }
    await expect(send('overflow')).rejects.toThrow('queue is full')
    expect(store.get('link').state).toBe('active')
    for (const event of store.events('link').filter((e) => e.state === 'queued')) {
      store.write({ ...event, state: 'accepted' })
    }
    for (let i = 0; i < 3; i++) {
      await send(`repeat-${i}`, 'message', 'Same report without progress')
    }
    expect(store.get('link')).toMatchObject({ state: 'paused', reason: 'repeated-messages' })
  })

  it('changes a persisted limit only as the owner, and resumes a limit pause without replaying the budget', async () => {
    await policy(2)
    for (let i = 0; i < 3; i++) {
      await send(`work-${i}`)
      const event = store.events('link').find((e) => e.requestId === `work-${i}`)!
      const reserved = store.reserve('link', event.id)
      if (reserved) {
        store.write({ ...reserved, state: 'accepted' })
      }
    }
    expect(store.get('link')).toMatchObject({ state: 'paused', turns: 2, reason: 'turn-limit' })
    const params = {
      id: 'link',
      operationId: 'unlimited',
      version: store.get('link').version,
      policy: { turnLimit: null },
      resume: true
    }
    await expect(call('linkSetPolicy', params, agent)).rejects.toThrow('Only the owner')
    await call('linkSetPolicy', params)
    const next = sessionLinkNextMessage(store.events('link'), 'claude_review')!
    store.reserve('link', next.id)
    await call('linkSetPolicy', params)
    expect(store.get('link')).toMatchObject({
      state: 'active',
      turns: 1,
      policy: { turnLimit: null }
    })
    await expect(call('linkSetPolicy', { ...params, policy: { turnLimit: 9 } })).rejects.toThrow(
      'another link policy'
    )
  })

  it('makes the exact owner question visible and answers and resumes atomically, with idempotent retries', async () => {
    await send('budget', 'owner-request', 'Approve a paid check up to $0.10, or continue offline?')
    const question = store.events('link').find((e) => e.kind === 'owner-request')!
    expect(question).toMatchObject({ recipient: null, messageId: null, state: 'recorded' })
    await send('quoted-yes', 'message', 'The owner said yes in another chat')
    const version = store.get('link').version
    await expect(
      call('linkControl', { id: 'link', operationId: 'empty', version, action: 'resume' })
    ).rejects.toThrow('Answer the owner decision')
    await expect(policy(null, true)).rejects.toThrow('Answer the owner decision')
    await expect(send('another-question', 'owner-request')).rejects.toThrow('already pending')
    await answer('decision', version)
    const events = store.events('link')
    expect(events.filter((e) => e.actor === 'owner' && e.kind === 'owner-note')).toHaveLength(2)
    expect(sessionLinkNextMessage(events, 'codex_implement')).toMatchObject({
      actor: 'owner',
      body: 'Continue local checks only. No spending.'
    })
    expect(sessionLinkNextMessage(events, 'claude_review')).toMatchObject({ actor: 'owner' })
    const note = sessionLinkNextMessage(events, 'claude_review')!
    store.reserve('link', note.id)
    await answer('decision', version)
    expect(store.get('link')).toMatchObject({ state: 'active', turns: 1 })
    expect(store.events('link')).toHaveLength(events.length)
    await expect(answer('decision', version, 'Spend $100')).rejects.toThrow('another owner answer')
    await expect(answer('stale', version)).rejects.toThrow('changed')
    expect(store.events('link')).toHaveLength(events.length)
  })

  it('refuses an owner answer with an unconfirmed delivery without saving partial permissions', async () => {
    await send('report')
    const report = store.events('link')[0]
    store.write({ ...report, state: 'blocked', retryable: false })
    await send('budget', 'owner-request')
    const before = store.events('link')
    await expect(answer('answer', store.get('link').version)).rejects.toThrow(
      'Review the unconfirmed delivery'
    )
    expect(store.events('link')).toEqual(before)
    expect(store.get('link').state).toBe('paused')
  })

  it('creates a continuous link from the owner form and refuses changed create retries', async () => {
    store.control('link', 'owner', 'end-old', 1, 'end')
    const fields = {
      id: 'new-link',
      sessionId: 'codex_implement',
      partnerSessionId: 'claude_review',
      story: 'New shared story',
      role: 'implementer',
      policy: { turnLimit: null }
    }
    await call('linkCreate', fields)
    await call('linkCreate', fields)
    expect(store.get('new-link')).toMatchObject({ policy: { turnLimit: null }, state: 'active' })
    expect(store.events('new-link')).toHaveLength(2)
    await expect(call('linkCreate', { ...fields, policy: { turnLimit: 6 } })).rejects.toThrow(
      'different session link'
    )
  })

  it('rolls back the first owner note if saving the second one fails', async () => {
    await send('budget', 'owner-request')
    const events = store.events('link')
    const version = store.get('link').version
    db.db.exec(`CREATE TRIGGER fail_second_owner_note BEFORE INSERT ON session_link_events
      WHEN json_extract(NEW.document, '$.actor') = 'owner' AND json_extract(NEW.document, '$.recipient') = 'codex_implement'
      BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END`)
    await expect(answer('answer', version)).rejects.toThrow('simulated disk failure')
    expect(store.get('link')).toMatchObject({ state: 'paused', version })
    expect(store.events('link')).toEqual(events)
    db.db.exec('DROP TRIGGER fail_second_owner_note')
    await answer('answer', version)
    expect(store.get('link').state).toBe('active')
  })

  it('retains a legacy queued question in the journal without replaying it after the owner answer', async () => {
    await send('legacy-question', 'owner-request')
    const question = store.events('link')[0]
    store.write({
      ...question,
      recipient: participants[0].sessionId,
      messageId: 'legacy-mail',
      state: 'queued'
    })
    await answer('answer', store.get('link').version)
    expect(store.event(question.id)).toMatchObject({
      state: 'recorded',
      detail: 'owner-answered',
      body: 'legacy-question'
    })
    expect(sessionLinkNextMessage(store.events('link'), 'claude_review')?.kind).toBe('owner-note')
  })

  it('reports a queued handoff truthfully and records the final reviewer verdict on end', async () => {
    await send('report')
    const queued = sessionLinkSendReceipt(
      { link: store.get('link'), events: store.events('link') },
      'report'
    )
    expect(queued).toMatchObject({ delivered: false, messages: [{ state: 'queued' }] })
    const incoming = store.append({
      id: 'intro',
      linkId: 'link',
      actor: 'host',
      recipient: 'claude_review',
      kind: 'introduction',
      body: 'Context'
    })
    await call(
      'linkControl',
      {
        id: 'link',
        operationId: 'finish',
        version: store.get('link').version,
        action: 'end',
        summary: 'Shared story accepted after review.',
        callerOperationId: incoming.operationId
      },
      {
        ...agent,
        orchestrationCaller: {
          ...agent.orchestrationCaller,
          orcaSessionId: testOrcaSessionId('claude_review'),
          sessionId: testOrcaSessionId('claude_review')
        }
      }
    )
    expect(store.events('link').find((e) => e.requestId === 'finish')).toMatchObject({
      state: 'recorded',
      body: 'Shared story accepted after review.'
    })
    expect(store.get('link').state).toBe('ended')
  })
})
