import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connector-cloud-contract'
import type { Delivery } from '../external-conversations/external-conversation-types'
import { connectorProjects } from './connector-places'
import { ConnectorPollClient } from './connector-poll-client'
import { ConnectorAccountTransport } from './connector-transport'
import { ConnectorTurnEvents } from './connector-turn-events'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'

const SERVER_NOW = 1_800_000_000_000
const conversation = { source: 'slack', externalId: 'T1:C9:1792.9:U5' } as const
const [project] = connectorProjects({
  getRepos: () => [
    { id: 'orca', path: '/src/orca', displayName: 'orca', badgeColor: '#000', addedAt: 1 }
  ],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [],
  getSshTargets: () => [],
  getProjectHostSetups: () => [],
  getAllWorktreeMeta: () => ({})
})

let userDataPath: string
let fake: FakeConnectorCloud

/** `events` stands for one process's outbox; a new one models a restart. */
function startClient(seam = fakeSeam(), events = new ConnectorTurnEvents(userDataPath, 'ada')) {
  const machine = fakeMachine(() => seam, [project!])
  const client = new ConnectorPollClient({
    transport: new ConnectorAccountTransport(fake.origin, fake.mintFor('ada'), fake.fetch),
    events,
    seam: seam.seam,
    machine,
    random: () => 0.5
  })
  client.start()
  return { client, machine, ...seam }
}

// Each step lets a chain of fetches and seam answers run to its next timer.
const settle = async (ms = 0): Promise<void> => {
  for (let step = 0; step < 50; step++) {
    await vi.advanceTimersByTimeAsync(ms / 50)
  }
}

function poll(deliveries: unknown[], extra: Record<string, unknown> = {}) {
  fake.answerPoll({
    status: 200,
    body: { v: 1, serverNow: SERVER_NOW, holdMs: 50_000, deliveries, ...extra }
  })
}

const base = { seq: 1, expiresAt: SERVER_NOW + 300_000, conversation }

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    now: SERVER_NOW
  })
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-client-'))
  fake = new FakeConnectorCloud()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('ConnectorPollClient', () => {
  it('says hello with capabilities and projects, then sends the snapshot', async () => {
    const { client } = startClient()
    await settle()
    expect(fake.hellos[0]).toMatchObject({
      v: 1,
      contract: 1,
      runtime: 'desktop',
      hostName: 'box',
      agents: ['claude', 'codex'],
      promptKinds: ['approval', 'question'],
      features: ['answer', 'cancel'],
      sources: ['slack'],
      projects: [{ placeId: project!.placeId, name: 'orca', kind: 'git' }]
    })
    expect(fake.events).toEqual([{ kind: 'snapshot', conversations: [] }])
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)
    client.stop()
  })

  it('confirms received right after the seam call, then done with its result', async () => {
    const seam = fakeSeam()
    const sent = Promise.withResolvers<Delivery>()
    seam.outcomes.set('d2', sent.promise)
    const { client, calls } = startClient(seam)
    await settle()
    poll([
      {
        ...base,
        deliveryId: 'd1',
        kind: 'start',
        agent: 'claude',
        placeId: project!.placeId,
        prompt: 'fix it'
      },
      { ...base, deliveryId: 'd2', kind: 'send', text: 'more' }
    ])
    await settle()
    expect(calls.start).toHaveBeenCalledWith(expect.anything(), conversation, 'd1', {
      agent: 'claude',
      prompt: 'fix it',
      target: expect.objectContaining({ kind: 'create-worktree' })
    })
    expect(fake.acks).toEqual([
      { deliveryId: 'd1', step: 'received' },
      { deliveryId: 'd2', step: 'received' },
      { deliveryId: 'd1', step: 'done', result: { outcome: 'accepted' } }
    ])
    sent.resolve({ outcome: 'refused', reason: 'agent_not_reachable' })
    await settle()
    expect(fake.acks.at(-1)).toEqual({
      deliveryId: 'd2',
      step: 'done',
      result: { outcome: 'refused', reason: 'agent_not_reachable' }
    })
    client.stop()
  })

  it('refuses stale and unreadable deliveries without the seam, and still runs the rest', async () => {
    const { client, calls } = startClient()
    await settle()
    poll([
      { ...base, deliveryId: 'old', kind: 'send', text: 'hi', expiresAt: SERVER_NOW + 9_000 },
      { ...base, deliveryId: 'new-kind', kind: 'rewind' },
      { kind: 'no-id' },
      {
        ...base,
        deliveryId: 'nowhere',
        kind: 'start',
        agent: 'claude',
        placeId: '???',
        prompt: 'x'
      },
      { ...base, deliveryId: 'gone', kind: 'answer', promptId: 'p1', optionId: 'allow_once' },
      { ...base, deliveryId: 'c1', kind: 'cancel' }
    ])
    await settle()
    expect(calls.send).not.toHaveBeenCalled()
    expect(calls.start).not.toHaveBeenCalled()
    expect(fake.acks).toEqual(
      expect.arrayContaining([
        { deliveryId: 'old', step: 'done', result: { outcome: 'expired' } },
        { deliveryId: 'new-kind', step: 'done', result: { outcome: 'unsupported' } },
        { deliveryId: 'nowhere', step: 'done', result: { outcome: 'unsupported' } },
        { deliveryId: 'gone', step: 'received' },
        {
          deliveryId: 'gone',
          step: 'done',
          result: { outcome: 'refused', reason: 'external_conversation_not_found' }
        },
        { deliveryId: 'c1', step: 'done', result: { outcome: 'accepted' } }
      ])
    )
    expect(fake.acks).not.toContainEqual({ deliveryId: 'old', step: 'received' })
    client.stop()
  })

  it('measures the deadline from when the poll was sent, so a slow answer only shortens it', async () => {
    const { client, calls } = startClient()
    await settle()
    // 15 s were left when the poll went out; the answer lands 6 s later, leaving 9 s.
    fake.pollReplyDelayMs = 6_000
    poll([
      { ...base, deliveryId: 'slow', kind: 'send', text: 'hi', expiresAt: SERVER_NOW + 15_000 }
    ])
    await settle(7_000)
    expect(calls.send).not.toHaveBeenCalled()
    expect(fake.acks).toContainEqual({
      deliveryId: 'slow',
      step: 'done',
      result: { outcome: 'expired' }
    })
    client.stop()
  })

  it('recovers deliveries an earlier process received from their receipts, never re-running them', async () => {
    const seam = fakeSeam()
    seam.recorded.set('d1', { outcome: 'accepted' })
    const { client, calls } = startClient(seam)
    await settle()
    poll([], {
      unsettled: [
        { deliveryId: 'd1', conversation },
        { deliveryId: 'd2', conversation }
      ]
    })
    await settle()
    expect(fake.acks).toEqual([
      { deliveryId: 'd1', step: 'done', result: { outcome: 'accepted' } },
      { deliveryId: 'd2', step: 'done', result: { outcome: 'unknown', reason: 'no_local_record' } }
    ])
    expect(calls.send).not.toHaveBeenCalled()
    expect(calls.start).not.toHaveBeenCalled()
    client.stop()
  })

  it('answers a resend after a lost received without calling the seam twice', async () => {
    const seam = fakeSeam()
    seam.outcomes.set('d1', new Promise(() => {}))
    const { client, calls } = startClient(seam)
    await settle()
    const send = { ...base, deliveryId: 'd1', kind: 'send', text: 'hi' }
    poll([send])
    await settle()
    poll([send], { unsettled: [{ deliveryId: 'd1', conversation }] })
    await settle()
    expect(calls.send).toHaveBeenCalledTimes(1)
    expect(seam.calls.recorded).not.toHaveBeenCalled()
    expect(fake.acks).toEqual([
      { deliveryId: 'd1', step: 'received' },
      { deliveryId: 'd1', step: 'received' }
    ])
    client.stop()
  })

  it('says hello again, with a fresh snapshot, when the cloud lost the hello', async () => {
    const { client } = startClient()
    await settle()
    fake.forgetHello()
    poll([])
    await settle()
    expect(fake.hellos).toHaveLength(2)
    expect(fake.events).toEqual([
      { kind: 'snapshot', conversations: [] },
      { kind: 'snapshot', conversations: [] }
    ])
    client.stop()
  })

  it('keeps a turn end on disk until the cloud accepts it, across a restart', async () => {
    const outboxFile = join(userDataPath, 'connector-turn-outbox.json')
    fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    const first = startClient()
    await settle()
    first.emit({
      kind: 'turn-ended',
      conversation,
      worktreeId: 'wt',
      paneKey: 'tab:1',
      turnId: 100,
      stopReason: 'success',
      lastAssistantMessage: `x${'é'.repeat(5_000)}`,
      at: 300
    })
    first.emit({
      kind: 'turn-started',
      conversation: { source: 'dev', externalId: 'x' },
      worktreeId: 'wt',
      paneKey: 'tab:2',
      at: 5
    })
    await settle()
    const stored = JSON.parse(readFileSync(outboxFile, 'utf8')).turnEnds
    expect(stored).toHaveLength(1)
    // 8 KB would split a two-byte character after the leading 'x', so the cut steps back one byte.
    expect(stored[0].lastAssistantMessage).toBe(`x${'é'.repeat(4_095)}`)
    first.client.stop()

    fake.forced.delete(CONNECTOR_PATHS.events)
    const second = startClient()
    await settle()
    expect(fake.events).toContainEqual(
      expect.objectContaining({ kind: 'turn-ended', turnId: 100, at: 300 })
    )
    expect(fake.events).not.toContainEqual(expect.objectContaining({ paneKey: 'tab:2' }))
    expect(existsSync(outboxFile)).toBe(false)
    second.client.stop()
  })

  it('stops when the cloud says so, e.g. for a too-old client', async () => {
    startClient()
    await settle()
    poll([], { control: { stop: 'client_too_old' } })
    await settle()
    const polls = fake.requestsTo(CONNECTOR_PATHS.poll).length
    await settle(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(polls)
  })

  it('mints a new token when one is refused, and waits out a lapsed sign-in without stopping', async () => {
    const { client } = startClient()
    await settle()
    fake.refuseTokens()
    poll([])
    await settle()
    expect(fake.minted).toHaveLength(2)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll).at(-1)?.token).toBe(fake.minted[1]?.token)

    fake.signedIn.delete('ada')
    fake.refuseTokens()
    poll([])
    await settle(10_000)
    const polls = fake.requestsTo(CONNECTOR_PATHS.poll).length
    fake.signedIn.add('ada')
    await settle(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll).length).toBeGreaterThan(polls)
    client.stop()
  })

  it('backs off through an outage and flushes confirmations once it is back', async () => {
    const { client } = startClient()
    await settle()
    fake.online = false
    poll([])
    await settle()
    const offlineAttempts = fake.requests.length
    await settle(3_000)
    expect(fake.requests.length).toBe(offlineAttempts)
    fake.online = true
    await settle(30_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll).length).toBeGreaterThan(1)
    client.stop()
  })

  it('stops when connectors are turned off', async () => {
    const { client, disable } = startClient()
    await settle()
    disable()
    await settle()
    const polls = fake.requestsTo(CONNECTOR_PATHS.poll).length
    poll([])
    await settle(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(polls)
    client.stop()
  })

  it('admits nothing once stopped: not a late poll answer, not a late result', async () => {
    const seam = fakeSeam()
    const late = Promise.withResolvers<Delivery>()
    seam.outcomes.set('d1', late.promise)
    const { client, calls } = startClient(seam)
    await settle()
    poll([{ ...base, deliveryId: 'd1', kind: 'send', text: 'hi' }])
    await settle()
    fake.pollReplyDelayMs = 1_000
    poll([{ ...base, deliveryId: 'd2', kind: 'send', text: 'late' }])
    await settle(10)
    client.stop()
    late.resolve({ outcome: 'accepted' })
    await settle(2_000)
    expect(calls.send).toHaveBeenCalledTimes(1)
    expect(fake.acks).toEqual([{ deliveryId: 'd1', step: 'received' }])
  })

  it('waits out Retry-After before sending confirmations again, however many are queued', async () => {
    const seam = fakeSeam()
    const done = Promise.withResolvers<Delivery>()
    seam.outcomes.set('d1', done.promise)
    const { client } = startClient(seam)
    await settle()
    fake.forced.set(CONNECTOR_PATHS.acks, { status: 429, headers: { 'retry-after': '300' } })
    poll([{ ...base, deliveryId: 'd1', kind: 'send', text: 'hi' }])
    await settle()
    done.resolve({ outcome: 'accepted' })
    await settle(60_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.acks)).toHaveLength(1)
    fake.forced.delete(CONNECTOR_PATHS.acks)
    await settle(250_000)
    expect(fake.acks).toEqual([
      { deliveryId: 'd1', step: 'received' },
      { deliveryId: 'd1', step: 'done', result: { outcome: 'accepted' } }
    ])
    client.stop()
  })

  it('says hello again when the agents it can run change', async () => {
    const { client, machine } = startClient()
    await settle()
    machine.agentList = ['claude']
    poll([])
    await settle()
    expect(fake.hellos.at(-1)).toMatchObject({ agents: ['claude'] })
    expect(fake.hellos).toHaveLength(2)
    client.stop()
  })

  it('keeps at most 200 turn ends, in memory and on disk alike', async () => {
    fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    const { client, emit } = startClient()
    await settle()
    for (let turn = 1; turn <= 250; turn++) {
      emit({
        kind: 'turn-ended',
        conversation,
        worktreeId: 'wt',
        paneKey: 'tab:1',
        turnId: turn,
        stopReason: null,
        at: turn
      })
    }
    const stored = JSON.parse(
      readFileSync(join(userDataPath, 'connector-turn-outbox.json'), 'utf8')
    ).turnEnds
    expect(stored.map((event: { turnId: number }) => event.turnId)).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 51)
    )
    client.stop()
  })

  it('opens each hello with the snapshot as batch 0 and keeps later events in order behind a retry', async () => {
    const { client, emit } = startClient()
    await settle()
    fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    emit({
      kind: 'prompt',
      conversation,
      worktreeId: 'wt',
      paneKey: 'tab:1',
      prompt: { kind: 'unsupported', promptId: 'old' }
    })
    await settle()
    emit({ kind: 'turn-started', conversation, worktreeId: 'wt', paneKey: 'tab:1', at: 7 })
    fake.forced.delete(CONNECTOR_PATHS.events)
    await settle(5_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.events).map(({ body }) => body)).toMatchObject([
      { seq: 0, events: [{ kind: 'snapshot' }] },
      { seq: 1, events: [{ kind: 'prompt' }] },
      { seq: 1, events: [{ kind: 'prompt' }] },
      { seq: 2, events: [{ kind: 'turn-started' }] }
    ])
    expect(fake.events).toMatchObject([
      { kind: 'snapshot' },
      { kind: 'prompt' },
      { kind: 'turn-started' }
    ])

    // Each hello names the revision the cloud gave it.
    expect(fake.requestsTo(CONNECTOR_PATHS.events)[0]?.body).toMatchObject({ helloRev: 1 })
    fake.forgetHello()
    poll([])
    await settle()
    const renewed = fake.requestsTo(CONNECTOR_PATHS.events).at(-1)?.body
    expect(renewed).toMatchObject({
      helloRev: 2,
      seq: 0,
      events: [{ kind: 'snapshot' }]
    })
    client.stop()
  })

  it('says hello again with a snapshot once the caps dropped a live event', async () => {
    const { client, emit } = startClient()
    await settle()
    fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    for (let index = 0; index <= 550; index++) {
      emit({
        kind: 'prompt',
        conversation,
        worktreeId: 'wt',
        paneKey: 'tab:1',
        prompt: { kind: 'unsupported', promptId: String(index) }
      })
    }
    fake.forced.delete(CONNECTOR_PATHS.events)
    poll([])
    await settle(40_000)
    expect(fake.hellos).toHaveLength(2)
    expect(
      fake.events.filter((event) => isRecord(event) && event.kind === 'snapshot')
    ).toHaveLength(2)
    client.stop()
  })

  it('settles a recovered delivery whose earlier run fails as unknown, never running it again', async () => {
    const seam = fakeSeam()
    seam.calls.recorded.mockRejectedValueOnce(new Error('launch_failed'))
    const { client, calls } = startClient(seam)
    await settle()
    poll([], { unsettled: [{ deliveryId: 'd1', conversation }] })
    await settle()
    expect(fake.acks).toEqual([
      { deliveryId: 'd1', step: 'done', result: { outcome: 'unknown', reason: 'launch_failed' } }
    ])
    expect(calls.send).not.toHaveBeenCalled()
    client.stop()
  })

  it('keeps turn ends that finish before the first hello, and sends them after its snapshot', async () => {
    fake.online = false
    const { client, emit } = startClient()
    await settle()
    emit({
      kind: 'turn-ended',
      conversation,
      worktreeId: 'wt',
      paneKey: 'tab:1',
      turnId: 4,
      stopReason: 'success',
      at: 9
    })
    expect(existsSync(join(userDataPath, 'connector-turn-outbox.json'))).toBe(true)
    fake.online = true
    await settle(30_000)
    expect(fake.events).toMatchObject([{ kind: 'snapshot' }, { kind: 'turn-ended', turnId: 4 }])
    client.stop()
  })

  it('sends a done again under a new hello when the old one was still in flight', async () => {
    const seam = fakeSeam()
    const sent = Promise.withResolvers<Delivery>()
    seam.outcomes.set('d1', sent.promise)
    const { client, machine } = startClient(seam)
    await settle()
    poll([{ ...base, deliveryId: 'd1', kind: 'send', text: 'hi' }])
    await settle()
    fake.holdBefore.add(CONNECTOR_PATHS.acks)
    sent.resolve({ outcome: 'accepted' })
    await settle()
    machine.agentList = ['claude']
    poll([], { unsettled: [{ deliveryId: 'd1', conversation }] })
    await settle()
    expect(fake.hellos).toHaveLength(2)
    fake.release(CONNECTOR_PATHS.acks)
    await settle(5_000)
    expect(fake.acks).toContainEqual({
      deliveryId: 'd1',
      step: 'done',
      result: { outcome: 'accepted' }
    })
    client.stop()
  })

  it('keeps a turn end whose request the cloud ignored while switching to a new hello', async () => {
    const { client, machine, emit } = startClient()
    await settle()
    fake.holdBefore.add(CONNECTOR_PATHS.events)
    emit({
      kind: 'turn-ended',
      conversation,
      worktreeId: 'wt',
      paneKey: 'tab:1',
      turnId: 4,
      stopReason: 'success',
      at: 9
    })
    await settle()
    // The cloud takes the new hello but its answer is late; the old request lands first, ignored.
    fake.holdAfter.add(CONNECTOR_PATHS.hello)
    machine.agentList = ['claude']
    poll([])
    await settle()
    fake.release(CONNECTOR_PATHS.events)
    await settle()
    fake.release(CONNECTOR_PATHS.hello)
    await settle(5_000)
    expect(fake.events).toContainEqual(expect.objectContaining({ kind: 'turn-ended', turnId: 4 }))
    client.stop()
  })

  it('says hello again after a failed one, even when what it says went back to the last accepted hello', async () => {
    const { client, machine, emit } = startClient()
    await settle()
    fake.forced.set(CONNECTOR_PATHS.hello, { status: 503 })
    machine.agentList = ['claude']
    poll([])
    await settle()
    machine.agentList = ['claude', 'codex']
    fake.forced.delete(CONNECTOR_PATHS.hello)
    emit({
      kind: 'turn-ended',
      conversation,
      worktreeId: 'wt',
      paneKey: 'tab:1',
      turnId: 4,
      stopReason: 'success',
      at: 9
    })
    await settle(30_000)
    expect(fake.events).toContainEqual(expect.objectContaining({ kind: 'turn-ended', turnId: 4 }))
    client.stop()
  })

  it('says hello again after a poll fails, so the cloud lists unsettled deliveries again', async () => {
    const { client } = startClient()
    await settle()
    fake.answerPoll({ status: 503 })
    await settle(5_000)
    expect(fake.hellos).toHaveLength(2)
    client.stop()
  })

  it('counts only the contract’s success: a 200 that is not one keeps the turn end', async () => {
    const { client, emit } = startClient()
    await settle()
    fake.forced.set(CONNECTOR_PATHS.events, { status: 200, body: '<html>proxy</html>' })
    emit({
      kind: 'turn-ended',
      conversation,
      worktreeId: 'wt',
      paneKey: 'tab:1',
      turnId: 4,
      stopReason: 'success',
      at: 9
    })
    await settle()
    fake.forced.delete(CONNECTOR_PATHS.events)
    await settle(5_000)
    expect(fake.events).toContainEqual(expect.objectContaining({ kind: 'turn-ended', turnId: 4 }))
    client.stop()
  })

  it('never takes a hello whose answer is not the contract', async () => {
    const { client } = startClient()
    fake.forced.set(CONNECTOR_PATHS.hello, { status: 204 })
    await settle(5_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(0)
    fake.forced.delete(CONNECTOR_PATHS.hello)
    await settle(30_000)
    expect(fake.requestsTo(CONNECTOR_PATHS.poll).length).toBeGreaterThan(0)
    client.stop()
  })

  it('fills event requests by bytes, so a backlog of long turn ends never meets a 413', async () => {
    const { client, emit } = startClient()
    fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    for (let turnId = 1; turnId <= 60; turnId++) {
      emit({
        kind: 'turn-ended',
        conversation,
        worktreeId: 'wt',
        paneKey: 'tab:1',
        turnId,
        stopReason: 'success',
        lastAssistantMessage: 'x'.repeat(8 * 1024),
        at: turnId
      })
    }
    await settle()
    fake.forced.delete(CONNECTOR_PATHS.events)
    await settle(30_000)
    expect(
      fake.events.filter((event) => isRecord(event) && event.kind === 'turn-ended')
    ).toHaveLength(60)
    expect(fake.requestsTo(CONNECTOR_PATHS.events).length).toBeGreaterThan(2)
    client.stop()
  })

  it('keeps a turn end refused under a hello a retired client replaced, and resends it after hello', async () => {
    const { client, emit } = startClient()
    await settle()
    fake.helloFromElsewhere()
    emit({
      kind: 'turn-ended',
      conversation,
      worktreeId: 'wt',
      paneKey: 'tab:1',
      turnId: 4,
      stopReason: 'success',
      at: 9
    })
    await settle()
    // The cloud wakes the held poll for the newer hello, as the real one does.
    fake.answerPoll({ status: 409, body: { error: 'hello_required' } })
    await settle(5_000)
    expect(fake.hellos).toHaveLength(2)
    expect(fake.events).toContainEqual(expect.objectContaining({ kind: 'turn-ended', turnId: 4 }))
    client.stop()
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
