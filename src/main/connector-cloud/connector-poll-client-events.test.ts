import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_PATHS
} from '../../shared/connectors/connector-cloud-contract'
import {
  conversation,
  isRecord,
  pollClientHarness,
  settle
} from './connector-poll-client.test-fixture'
import { ConnectorTurnEvents } from './connector-turn-events'
import { FAKE_BOT } from './fake-connector-seam.test-fixture'

const h = pollClientHarness()
const { startClient, poll } = h

// Turn ends and live events: kept until the cloud takes them, in order, within their caps.
describe('ConnectorPollClient events', () => {
  it('keeps a turn end on disk until the cloud accepts it, across a restart', async () => {
    const outboxFile = join(h.userDataPath, 'connector-turn-outbox.json')
    h.fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
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
      conversation: { source: 'linear', externalId: 'x' },
      worktreeId: 'wt',
      paneKey: 'tab:2',
      at: 5
    })
    await settle()
    await ConnectorTurnEvents.settled()
    const stored = JSON.parse(readFileSync(outboxFile, 'utf8')).turnEnds
    expect(stored).toHaveLength(1)
    // Kept whole while it waits: it is cut for the cloud that takes it, as it goes.
    expect(stored[0].lastAssistantMessage).toBe(`x${'é'.repeat(5_000)}`)
    first.client.stop()

    h.fake.forced.delete(CONNECTOR_PATHS.events)
    const second = startClient()
    await settle()
    // This cloud lists no answers.long: within 8 KB with its note, no two-byte character split.
    expect(h.fake.events).toContainEqual(
      expect.objectContaining({
        kind: 'turn-ended',
        turnId: 100,
        at: 300,
        lastAssistantMessage: `x${'é'.repeat(4_068)}\n\n_… cut short here. The full answer is in Orca._`
      })
    )
    expect(h.fake.events).not.toContainEqual(expect.objectContaining({ paneKey: 'tab:2' }))
    await ConnectorTurnEvents.settled()
    expect(existsSync(outboxFile)).toBe(false)
    second.client.stop()
  })

  it('opens each hello with the snapshot as batch 0 and keeps later events in order behind a retry', async () => {
    const { client, emit } = startClient()
    await settle()
    h.fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    emit({
      kind: 'prompt',
      conversation,
      worktreeId: 'wt',
      paneKey: 'tab:1',
      prompt: { kind: 'unsupported', promptId: 'old' }
    })
    await settle()
    emit({ kind: 'turn-started', conversation, worktreeId: 'wt', paneKey: 'tab:1', at: 7 })
    h.fake.forced.delete(CONNECTOR_PATHS.events)
    await settle(5_000)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.events).map(({ body }) => body)).toMatchObject([
      { seq: 0, events: [{ kind: 'snapshot' }] },
      { seq: 1, events: [{ kind: 'prompt' }] },
      { seq: 1, events: [{ kind: 'prompt' }] },
      { seq: 2, events: [{ kind: 'turn-started' }] }
    ])
    expect(h.fake.events).toMatchObject([
      { kind: 'snapshot' },
      { kind: 'prompt' },
      { kind: 'turn-started' }
    ])

    // Each hello names the revision the cloud gave it.
    expect(h.fake.requestsTo(CONNECTOR_PATHS.events)[0]?.body).toMatchObject({ helloRev: 1 })
    h.fake.forgetHello()
    poll([])
    await settle()
    const renewed = h.fake.requestsTo(CONNECTOR_PATHS.events).at(-1)?.body
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
    h.fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    for (let index = 0; index <= 550; index++) {
      emit({
        kind: 'prompt',
        conversation,
        worktreeId: 'wt',
        paneKey: 'tab:1',
        prompt: { kind: 'unsupported', promptId: String(index) }
      })
    }
    h.fake.forced.delete(CONNECTOR_PATHS.events)
    poll([])
    await settle(40_000)
    expect(h.fake.hellos).toHaveLength(2)
    expect(
      h.fake.events.filter((event) => isRecord(event) && event.kind === 'snapshot')
    ).toHaveLength(2)
    client.stop()
  })

  it('keeps turn ends that finish before the first hello, and sends them after its snapshot', async () => {
    h.fake.online = false
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
    await ConnectorTurnEvents.settled()
    expect(existsSync(join(h.userDataPath, 'connector-turn-outbox.json'))).toBe(true)
    h.fake.online = true
    await settle(30_000)
    expect(h.fake.events).toMatchObject([{ kind: 'snapshot' }, { kind: 'turn-ended', turnId: 4 }])
    client.stop()
  })

  it('keeps a turn end whose request the cloud ignored while switching to a new hello', async () => {
    const { client, machine, emit } = startClient()
    await settle()
    h.fake.holdBefore.add(CONNECTOR_PATHS.events)
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
    h.fake.holdAfter.add(CONNECTOR_PATHS.hello)
    machine.botList = [FAKE_BOT]
    poll([])
    await settle()
    h.fake.release(CONNECTOR_PATHS.events)
    await settle()
    h.fake.release(CONNECTOR_PATHS.hello)
    await settle(5_000)
    expect(h.fake.events).toContainEqual(expect.objectContaining({ kind: 'turn-ended', turnId: 4 }))
    client.stop()
  })

  it('counts only the contract’s success: a 200 that is not one keeps the turn end', async () => {
    const { client, emit } = startClient()
    await settle()
    h.fake.forced.set(CONNECTOR_PATHS.events, { status: 200, body: '<html>proxy</html>' })
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
    h.fake.forced.delete(CONNECTOR_PATHS.events)
    await settle(5_000)
    expect(h.fake.events).toContainEqual(expect.objectContaining({ kind: 'turn-ended', turnId: 4 }))
    client.stop()
  })

  it('fills event requests by bytes, so a backlog of long turn ends never meets a 413', async () => {
    const { client, emit } = startClient()
    h.fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
    // More than one request's worth, whatever the cap, and under the 200 turn ends kept.
    const backlog = Math.ceil((CONNECTOR_CLIENT_LIMITS.maxRequestBytes * 1.2) / (8 * 1024))
    for (let turnId = 1; turnId <= backlog; turnId++) {
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
    h.fake.forced.delete(CONNECTOR_PATHS.events)
    await settle(30_000)
    expect(
      h.fake.events.filter((event) => isRecord(event) && event.kind === 'turn-ended')
    ).toHaveLength(backlog)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.events).length).toBeGreaterThan(2)
    client.stop()
  })

  it('keeps a turn end refused under a hello a retired client replaced, and resends it after hello', async () => {
    const { client, emit } = startClient()
    await settle()
    h.fake.helloFromElsewhere()
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
    h.fake.answerPoll({ status: 409, body: { error: 'hello_required' } })
    await settle(5_000)
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.fake.events).toContainEqual(expect.objectContaining({ kind: 'turn-ended', turnId: 4 }))
    client.stop()
  })
})
