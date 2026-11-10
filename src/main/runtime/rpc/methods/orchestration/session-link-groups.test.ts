import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { SessionLinkStore } from '../../../orchestration/session-links/session-link-store'
import { sessionLinkCandidates } from '../../../orchestration/session-links/session-link-participants'
import { sessionLinkTestParticipants as pair } from '../../../orchestration/session-links/session-link-test-fixture'
import { SESSION_LINK_METHODS } from './session-link-methods'
import { SessionLinkParticipant } from '../../../../../shared/session-link'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'

vi.mock('../../../orchestration/session-links/session-link-delivery', () => ({
  redriveSessionLinks: vi.fn(async () => {}),
  scheduleSessionLinkDelivery: vi.fn()
}))
vi.mock('../../../orchestration/session-links/session-link-participants', () => ({
  sessionLinkCandidates: vi.fn()
}))
const gemini = SessionLinkParticipant.parse({
  ...pair[1],
  sessionId: 'gemini_checks',
  conversationId: 'gemini_checks',
  agent: 'gemini',
  name: 'Gemini checks'
})
let db: OrchestrationDb
let runtime: OrcaRuntimeService
let store: SessionLinkStore
let owner: RpcContext
const call = (name: string, params: unknown, context = owner) => {
  const method = eraseRpcMethods(SESSION_LINK_METHODS).find(
    (m) => m.name === `orchestration.${name}`
  )!
  return method.handler(method.params?.parse(params), context)
}
const agent = (sessionId: string): RpcContext => ({
  runtime,
  caller: { kind: 'local-cli' },
  orchestrationCaller: {
    address: `orca_session_id:${sessionId}`,
    terminalHandle: null,
    paneKey: null,
    orcaSessionId: testOrcaSessionId(sessionId),
    sessionId: testOrcaSessionId(sessionId),
    workspaceId: pair[1].workspaceId
  }
})
const add = (operationId = 'join') => ({
  id: 'link',
  operationId,
  version: store.get('link').version,
  sessionIds: [gemini.sessionId],
  groupSupport: true
})
const send = (operationId: string, fields: Record<string, unknown> = {}) => ({
  id: 'link',
  operationId,
  groupSupport: true,
  body: 'Check checkout flow.',
  kind: 'message',
  ...fields
})

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  store = new SessionLinkStore(db)
  owner = { runtime, caller: { kind: 'paired-device', deviceId: 'windows' }, clientKind: 'runtime' }
  vi.mocked(sessionLinkCandidates).mockResolvedValue([...pair, gemini])
  store.create('link', 'Checkout flow', pair, { turnLimit: 20 })
})
afterEach(() => db.close())

it('adds Gemini to the running pair without losing its journal, budget or pause, and replays after the new chat closes', async () => {
  store.append({
    id: 'pending',
    linkId: 'link',
    actor: pair[0].sessionId,
    recipient: pair[1].sessionId,
    body: 'Existing work',
    kind: 'checkpoint'
  })
  store.reserve('link', 'pending')
  store.pause('link', 'owner-decision')
  const before = store.get('link')
  const params = add()
  await call('linkAddParticipants', params)
  expect(store.get('link')).toMatchObject({
    id: before.id,
    story: before.story,
    state: 'paused',
    reason: 'owner-decision',
    turns: 1,
    messages: 1,
    policy: before.policy,
    version: before.version + 1
  })
  expect(store.forSession(gemini.conversationId)?.participants).toHaveLength(3)
  expect(store.event('pending')).toMatchObject({ state: 'dispatching', body: 'Existing work' })
  const introductions = store.events('link').filter((e) => e.kind === 'introduction')
  expect(introductions.map((e) => e.recipient)).toEqual([...pair, gemini].map((p) => p.sessionId))
  expect(
    introductions.every((e) => e.body.includes('existing story and journal are unchanged'))
  ).toBe(true)
  const events = store.events('link')
  vi.mocked(sessionLinkCandidates).mockResolvedValue([])
  await call('linkAddParticipants', params)
  expect(store.events('link')).toEqual(events)
  await expect(
    call('linkAddParticipants', { ...params, sessionIds: [pair[0].sessionId] })
  ).rejects.toThrow('another link membership')
})

it('creates a multi-provider group directly and preserves ordinary pair creation', async () => {
  await call('linkControl', { id: 'link', operationId: 'end', version: 1, action: 'end' })
  const params = {
    id: 'group',
    sessionId: pair[0].sessionId,
    partnerSessionIds: [pair[1].sessionId, gemini.sessionId],
    groupSupport: true,
    story: 'Checkout tests',
    role: 'reviewer',
    policy: { turnLimit: 20 }
  }
  await call('linkCreate', params)
  await call('linkCreate', params)
  await expect(
    call('linkCreate', { ...params, partnerSessionIds: [pair[1].sessionId] })
  ).rejects.toThrow('different session link')
  expect(store.get('group').participants.map((p) => p.agent)).toEqual(['claude', 'codex', 'gemini'])
  expect(store.events('group')).toHaveLength(3)
})

it('refuses agent/mobile membership changes, stale versions, occupied chats and duplicate aliases atomically', async () => {
  const params = add()
  for (const context of [agent(pair[0].sessionId), { ...owner, clientKind: 'mobile' as const }]) {
    await expect(call('linkAddParticipants', params, context)).rejects.toThrow('Only the owner')
  }
  for (const fields of [
    { version: 9 },
    { sessionIds: [gemini.sessionId, gemini.sessionId] },
    { sessionIds: ['missing-chat'] },
    { sessionIds: [pair[0].sessionId] }
  ]) {
    await expect(call('linkAddParticipants', { ...params, ...fields })).rejects.toThrow()
    expect(store.get('link').participants).toEqual(pair)
    expect(store.forSession(gemini.sessionId)).toBeNull()
    expect(store.events('link')).toEqual([])
  }
})

it('routes new messages to exactly the selected peer, replies to their author, and owner notes to everyone', async () => {
  await call('linkAddParticipants', add())
  expect(() => call('linkSend', send('ambiguous'), agent(pair[1].sessionId))).toThrow('--to')
  expect(() =>
    call('linkSend', send('outside', { to: 'unrelated-chat' }), agent(pair[1].sessionId))
  ).toThrow('--to')
  call(
    'linkSend',
    send('check', { to: gemini.sessionId, kind: 'checkpoint' }),
    agent(pair[1].sessionId)
  )
  const checkpoint = store.events('link').find((e) => e.requestId === 'check')!
  expect(checkpoint.recipient).toBe(gemini.sessionId)
  call(
    'linkSend',
    send('answer', { kind: 'reply', replyTo: checkpoint.id, body: 'Verified.' }),
    agent(gemini.sessionId)
  )
  expect(store.events('link').find((e) => e.requestId === 'answer')).toMatchObject({
    actor: gemini.sessionId,
    recipient: pair[1].sessionId,
    replyTo: checkpoint.id
  })
  call('linkSend', send('owner', { kind: 'owner-note' }))
  expect(
    store
      .events('link')
      .filter((e) => e.requestId === 'owner')
      .map((e) => e.recipient)
  ).toEqual([...pair, gemini].map((p) => p.sessionId))
  call(
    'linkSend',
    send('ask', { kind: 'owner-request', body: 'Continue?' }),
    agent(gemini.sessionId)
  )
  expect(store.events('link').filter((e) => e.requestId === 'ask')).toHaveLength(1)
  expect(store.get('link').reason).toBe('owner-decision')
})

it('retains the original recipients when an owner send is retried after membership grows', async () => {
  call('linkSend', send('owner', { kind: 'owner-note' }))
  const events = store.events('link')
  await call('linkAddParticipants', add())
  call('linkSend', send('owner', { kind: 'owner-note' }))
  expect(store.events('link').filter((e) => e.requestId === 'owner')).toEqual(events)
})

it('replays owner continuation after adding a peer without duplicating the decision or accepting changed answer content', async () => {
  call('linkSend', send('ask', { kind: 'owner-request' }), agent(pair[0].sessionId))
  const answer = {
    id: 'link',
    operationId: 'decision',
    groupSupport: true,
    version: store.get('link').version,
    action: 'resume',
    ownerMessage: 'Continue offline only.'
  }
  await call('linkControl', answer)
  const notes = store
    .events('link')
    .filter((e) => e.requestId === 'decision' && e.kind === 'owner-note')
  await call('linkAddParticipants', add())
  await call('linkControl', answer)
  expect(
    store.events('link').filter((e) => e.requestId === 'decision' && e.kind === 'owner-note')
  ).toEqual(notes)
  await expect(call('linkControl', { ...answer, ownerMessage: undefined })).rejects.toThrow(
    'another owner answer'
  )
  const pause = {
    id: 'link',
    operationId: 'pause',
    groupSupport: true,
    version: store.get('link').version,
    action: 'pause'
  }
  await call('linkControl', pause)
  await expect(
    call('linkControl', { ...pause, action: 'resume', ownerMessage: 'Changed request' })
  ).rejects.toThrow('another owner answer')
})

it('refuses old clients before effects on group reads, sends, controls and policy changes', async () => {
  await call('linkAddParticipants', add())
  const before = store.events('link')
  expect(() => call('linkCurrent', { sessionId: pair[0].sessionId })).toThrow('Update this Orca')
  expect(() =>
    call('linkSend', { ...send('old', { kind: 'owner-note' }), groupSupport: undefined })
  ).toThrow('Update this Orca')
  await expect(
    call('linkControl', { id: 'link', operationId: 'old', version: 2, action: 'pause' })
  ).rejects.toThrow('Update this Orca')
  await expect(
    call('linkSetPolicy', {
      id: 'link',
      operationId: 'old',
      version: 2,
      policy: { turnLimit: null }
    })
  ).rejects.toThrow('Update this Orca')
  expect(store.events('link')).toEqual(before)
  expect(call('linkShow', { id: 'link', groupSupport: true })).toMatchObject({
    link: { participants: [...pair, gemini] }
  })
})

it('allows many chats of the same provider/account and chunks large rosters within the mail byte limit', async () => {
  const extra = Array.from({ length: 24 }, (_, i) =>
    SessionLinkParticipant.parse({
      ...gemini,
      agent: 'codex',
      sessionId: `codex-extra-${i}`,
      conversationId: `codex-extra-${i}`,
      name: 'Checkout verification',
      task: 'Verify checkout. '.repeat(100)
    })
  )
  vi.mocked(sessionLinkCandidates).mockResolvedValue([...pair, ...extra])
  await call('linkAddParticipants', { ...add(), sessionIds: extra.map((p) => p.sessionId) })
  expect(store.get('link').participants).toHaveLength(26)
  expect(extra.every((p) => store.forSession(p.sessionId)?.id === 'link')).toBe(true)
  const introductions = store.events('link').filter((e) => e.kind === 'introduction')
  expect(introductions.length).toBeGreaterThan(26)
  expect(introductions.every((e) => Buffer.byteLength(e.body) <= 8192)).toBe(true)
})
