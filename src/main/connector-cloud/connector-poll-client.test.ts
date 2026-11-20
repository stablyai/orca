import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_PATHS
} from '../../shared/connectors/connector-cloud-contract'
import type { Delivery } from '../external-conversations/external-conversation-types'
import {
  base,
  conversation,
  pollClientHarness,
  SERVER_NOW,
  settle
} from './connector-poll-client.test-fixture'
import { FAKE_BOT, fakeSeam } from './fake-connector-seam.test-fixture'
import { CONNECTOR_REHELLO_SPREAD_MS } from './connector-poll-control'

const h = pollClientHarness()
const { startClient, poll } = h

describe('ConnectorPollClient', () => {
  it('applies the hello answer, publishes the initial snapshot and starts polling', async () => {
    const helloAnswered = vi.fn()
    h.fake.features = ['webhooks']
    h.fake.webhookTombstones = ['wh_7Kx2pQ9mZbV4tL1r']
    const { client } = startClient(undefined, undefined, (machine) => {
      machine.helloAnswered = helloAnswered
    })
    await settle()
    expect(helloAnswered).toHaveBeenCalledExactlyOnceWith({
      helloRev: expect.any(Number),
      features: ['webhooks'],
      webhookTombstones: ['wh_7Kx2pQ9mZbV4tL1r']
    })
    expect(h.fake.events).toEqual([{ kind: 'snapshot', conversations: [] }])
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)
    client.stop()
  })

  it('passes who asked and where to the seam; facts it can’t read drop, the delivery doesn’t', async () => {
    const seam = fakeSeam()
    const { client, calls } = startClient(seam)
    await settle()
    const placeId = Buffer.from(JSON.stringify(['bot', 'b1'])).toString('base64url')
    const asker = {
      userId: 'U0SAM',
      role: 'member',
      place: { kind: 'public_channel', id: 'C9' },
      text: 'hi',
      context: [{ kind: 'unreadable' }]
    }
    const start = { ...base, kind: 'start', agent: 'claude', placeId, prompt: 'hi' }
    poll([
      { ...start, deliveryId: 'd1', asker },
      { ...base, deliveryId: 'd2', kind: 'send', text: 'more', asker },
      // From a newer cloud: a role this Orca can't name.
      { ...base, deliveryId: 'd3', kind: 'send', text: 'again', asker: { ...asker, role: 'admin' } }
    ])
    await settle()
    // The same person's send that came with the start runs in its turn.
    expect(calls.start).toHaveBeenCalledWith(expect.anything(), conversation, 'd1', {
      agent: 'claude',
      prompt: 'hi',
      target: { kind: 'bot', botId: 'b1' },
      asker,
      later: [{ text: 'more', asker }]
    })
    expect(calls.carried.mock.calls.map((call) => call.slice(1, 3))).toEqual([['d2', 'more']])
    expect(calls.send.mock.calls.map((call) => call.slice(2))).toEqual([['d3', { text: 'again' }]])
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
        placeId: Buffer.from(JSON.stringify(['bot', 'b1'])).toString('base64url'),
        prompt: 'fix it'
      },
      // Someone else's, so it goes on its own rather than in the start's turn.
      {
        ...base,
        deliveryId: 'd2',
        kind: 'send',
        text: 'more',
        asker: {
          userId: 'U0SAM',
          role: 'member',
          place: { kind: 'public_channel', id: 'C9' },
          text: 'more',
          context: []
        }
      }
    ])
    await settle()
    expect(calls.start).toHaveBeenCalledWith(expect.anything(), conversation, 'd1', {
      agent: 'claude',
      prompt: 'fix it',
      target: { kind: 'bot', botId: 'b1' }
    })
    expect(h.fake.acks).toEqual([
      { deliveryId: 'd1', step: 'received' },
      { deliveryId: 'd2', step: 'received' },
      { deliveryId: 'd1', step: 'done', result: { outcome: 'accepted' } }
    ])
    sent.resolve({ outcome: 'refused', reason: 'agent_not_reachable' })
    await settle()
    expect(h.fake.acks.at(-1)).toEqual({
      deliveryId: 'd2',
      step: 'done',
      result: { outcome: 'refused', reason: 'agent_not_reachable' }
    })
    client.stop()
  })

  it("hands a trigger to the bot automation's run, and refuses one it no longer takes", async () => {
    const { client, machine } = startClient()
    const run = vi.fn<typeof machine.runTrigger>()
    run.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    machine.runTrigger = run
    await settle()
    const trigger = {
      ...base,
      kind: 'trigger',
      automationId: 'auto-1',
      triggerId: 't1',
      botId: 'bot-1',
      event: {
        key: 'T1:C1:1.1',
        actorId: 'U0MEMBER',
        occurredAt: SERVER_NOW,
        text: 'deploys are failing'
      }
    }
    poll([
      { ...trigger, deliveryId: 'tr1' },
      { ...trigger, deliveryId: 'tr2' }
    ])
    await settle()
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ automationId: 'auto-1', triggerId: 't1' })
    )
    // Only done: until the run exists, a resend is safe.
    expect(h.fake.acks).toEqual([
      { deliveryId: 'tr1', step: 'done', result: { outcome: 'accepted' } },
      {
        deliveryId: 'tr2',
        step: 'done',
        result: { outcome: 'refused', reason: 'automation_not_listening' }
      }
    ])
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
    expect(h.fake.acks).toEqual(
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
    expect(h.fake.acks).not.toContainEqual({ deliveryId: 'old', step: 'received' })
    client.stop()
  })

  it('runs the deadline from when the poll was answered, so a held poll does not shorten it', async () => {
    const { client, calls } = startClient()
    await settle()
    // The poll is held 40 s; the cloud stamps serverNow when it answers.
    await settle(40_000)
    const answeredAt = SERVER_NOW + 40_000
    poll(
      [
        {
          ...base,
          deliveryId: 'held',
          kind: 'send',
          text: 'hi',
          askedAt: answeredAt - 2_000,
          expiresAt: answeredAt + 300_000
        }
      ],
      { serverNow: answeredAt }
    )
    await settle()
    // The cloud's clock read from the local deadline: answered 2 s after it was asked, not 42 s.
    expect(calls.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'held',
      expect.objectContaining({ sent: { askedAt: answeredAt - 2_000, waitedMs: 2_000 } })
    )
    client.stop()
  })

  it('keeps its hello through a 5xx poll, and says a new one after a 409 or a lost answer', async () => {
    const { client } = startClient()
    await settle()
    h.fake.answerPoll({ status: 500 })
    await settle(30_000)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll).length).toBeGreaterThan(1)
    expect(h.fake.hellos).toHaveLength(1)

    h.fake.answerPoll({ status: 409, body: { error: 'hello_required' } })
    await settle(30_000)
    expect(h.fake.hellos).toHaveLength(2)

    h.fake.online = false
    poll([])
    await settle()
    h.fake.online = true
    await settle(30_000)
    expect(h.fake.hellos).toHaveLength(3)
    client.stop()
  })

  it('says a new hello after a poll that timed out', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms)
      return controller.signal
    })
    onTestFinished(() => timeout.mockRestore())
    const { client } = startClient()
    await settle()
    await settle(CONNECTOR_CLIENT_LIMITS.pollTimeoutMs + 30_000)
    expect(h.fake.hellos).toHaveLength(2)
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
    expect(h.fake.acks).toEqual([
      { deliveryId: 'd1', step: 'done', result: { outcome: 'accepted' } },
      { deliveryId: 'd2', step: 'done', result: { outcome: 'unknown', reason: 'no_local_record' } }
    ])
    expect(calls.send).not.toHaveBeenCalled()
    expect(calls.start).not.toHaveBeenCalled()
    client.stop()
  })

  it('never confirms a resent trigger received while its run starts, so a quit leaves it to be resent', async () => {
    const { client, machine } = startClient()
    let finish: (taken: boolean) => void = () => {}
    const run = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)))
    machine.runTrigger = run
    await settle()
    const trigger = {
      ...base,
      deliveryId: 'tr1',
      kind: 'trigger',
      automationId: 'auto-1',
      triggerId: 't1',
      botId: 'bot-1',
      event: { key: 'T1:C1:1.1', actorId: 'U0MEMBER', occurredAt: SERVER_NOW }
    }
    poll([trigger])
    await settle()
    // Its lease ran out while the run starts: the resend is dropped, never confirmed received.
    poll([trigger])
    await settle()
    expect(run).toHaveBeenCalledTimes(1)
    expect(h.fake.acks).toEqual([])
    finish(true)
    await settle()
    expect(h.fake.acks).toEqual([
      { deliveryId: 'tr1', step: 'done', result: { outcome: 'accepted' } }
    ])
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
    expect(h.fake.acks).toEqual([
      { deliveryId: 'd1', step: 'received' },
      { deliveryId: 'd1', step: 'received' }
    ])
    client.stop()
  })

  it('says hello again after a long silence, so the snapshot restates running workers', async () => {
    const { client } = startClient()
    // A poll held as long as usual says nothing new; the next is held while asleep or offline,
    // until the cloud forgot this machine's workers.
    await settle(50_000)
    poll([])
    await settle(11 * 60_000)
    expect(h.fake.hellos).toHaveLength(1)
    poll([])
    await settle()
    expect(h.fake.hellos).toHaveLength(2)
    client.stop()
  })

  it('says hello again once polls recover from a long 5xx outage, so the snapshot restates running workers', async () => {
    const { client } = startClient()
    await settle()
    h.fake.forced.set(CONNECTOR_PATHS.poll, { status: 503 })
    poll([])
    await settle(25 * 60_000)
    expect(h.fake.hellos).toHaveLength(1)
    h.fake.forced.delete(CONNECTOR_PATHS.poll)
    poll([])
    await settle(60_000)
    expect(h.fake.hellos).toHaveLength(2)
    client.stop()
  })

  it('says hello again, with a fresh snapshot, when the cloud lost the hello', async () => {
    const { client } = startClient()
    await settle()
    h.fake.forgetHello()
    poll([])
    await settle(CONNECTOR_REHELLO_SPREAD_MS)
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.fake.events).toEqual([
      { kind: 'snapshot', conversations: [] },
      { kind: 'snapshot', conversations: [] }
    ])
    client.stop()
  })

  it('says its first hello at once, and waits a random spread before a hello a 409 asked for', async () => {
    const { client } = startClient()
    await settle()
    expect(h.fake.hellos).toHaveLength(1)
    // As after a deploy that changed the cloud's features; random() is 0.5 here, so 30 s.
    h.fake.answerPoll({ status: 409, body: { error: 'hello_required' } })
    await settle(CONNECTOR_REHELLO_SPREAD_MS / 2 - 1_000)
    expect(h.fake.hellos).toHaveLength(1)
    await settle(2_000)
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll).at(-1)?.body).toMatchObject({ helloRev: 2 })
    client.stop()
  })

  it('stops when the cloud says so, e.g. for a too-old client', async () => {
    startClient()
    await settle()
    poll([], { control: { stop: 'client_too_old' } })
    await settle()
    const polls = h.fake.requestsTo(CONNECTOR_PATHS.poll).length
    await settle(60_000)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(polls)
  })

  it('mints a new token when one is refused, and waits out a lapsed sign-in without stopping', async () => {
    const { client } = startClient()
    await settle()
    h.fake.refuseTokens()
    poll([])
    await settle()
    expect(h.fake.minted).toHaveLength(2)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll).at(-1)?.token).toBe(h.fake.minted[1]?.token)

    h.fake.signedIn.delete('ada')
    h.fake.refuseTokens()
    poll([])
    await settle(10_000)
    const polls = h.fake.requestsTo(CONNECTOR_PATHS.poll).length
    h.fake.signedIn.add('ada')
    await settle(60_000)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll).length).toBeGreaterThan(polls)
    client.stop()
  })

  it('backs off through an outage and flushes confirmations once it is back', async () => {
    const { client } = startClient()
    await settle()
    h.fake.online = false
    poll([])
    await settle()
    const offlineAttempts = h.fake.requests.length
    await settle(3_000)
    expect(h.fake.requests.length).toBe(offlineAttempts)
    h.fake.online = true
    await settle(30_000)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll).length).toBeGreaterThan(1)
    client.stop()
  })

  it('stops when connectors are turned off', async () => {
    const { client, disable } = startClient()
    await settle()
    disable()
    await settle()
    const polls = h.fake.requestsTo(CONNECTOR_PATHS.poll).length
    poll([])
    await settle(60_000)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(polls)
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
    h.fake.pollReplyDelayMs = 1_000
    poll([{ ...base, deliveryId: 'd2', kind: 'send', text: 'late' }])
    await settle(10)
    client.stop()
    late.resolve({ outcome: 'accepted' })
    await settle(2_000)
    expect(calls.send).toHaveBeenCalledTimes(1)
    expect(h.fake.acks).toEqual([{ deliveryId: 'd1', step: 'received' }])
  })

  it('waits out Retry-After before sending confirmations again, however many are queued', async () => {
    const seam = fakeSeam()
    const done = Promise.withResolvers<Delivery>()
    seam.outcomes.set('d1', done.promise)
    const { client } = startClient(seam)
    await settle()
    h.fake.forced.set(CONNECTOR_PATHS.acks, { status: 429, headers: { 'retry-after': '300' } })
    poll([{ ...base, deliveryId: 'd1', kind: 'send', text: 'hi' }])
    await settle()
    done.resolve({ outcome: 'accepted' })
    await settle(60_000)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.acks)).toHaveLength(1)
    h.fake.forced.delete(CONNECTOR_PATHS.acks)
    await settle(250_000)
    expect(h.fake.acks).toEqual([
      { deliveryId: 'd1', step: 'received' },
      { deliveryId: 'd1', step: 'done', result: { outcome: 'accepted' } }
    ])
    client.stop()
  })

  it('says a changed hello at once, while the poll stays held', async () => {
    const { client, machine } = startClient()
    await settle()
    client.sayChanged()
    await settle()
    expect(h.fake.hellos).toHaveLength(1)
    machine.botList = [FAKE_BOT]
    client.sayChanged()
    await settle()
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)
    // The cloud refuses the held poll under the old hello; the next poll uses the new one, no third hello.
    h.fake.answerPoll({ status: 409, body: { error: 'hello_required' } })
    await settle()
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll).at(-1)?.body).toMatchObject({ helloRev: 2 })
    client.stop()
  })

  it('cuts a 409’s spread short to say a change made during it', async () => {
    const { client, machine } = startClient()
    await settle()
    h.fake.answerPoll({ status: 409, body: { error: 'hello_required', reason: 'features' } })
    await settle(1_000)
    expect(h.fake.hellos).toHaveLength(1)
    machine.botList = [FAKE_BOT]
    client.sayChanged()
    await settle(1_000)
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll).at(-1)?.body).toMatchObject({ helloRev: 2 })
    client.stop()
  })

  it('polls on a hello said during the held poll, without waiting a spread, when the 409 beats it', async () => {
    const { client, machine } = startClient()
    await settle()
    h.fake.holdAfter.add(CONNECTOR_PATHS.hello)
    machine.botList = [FAKE_BOT]
    client.sayChanged()
    await settle()
    // The cloud refuses the held poll before the new hello's answer arrives.
    h.fake.answerPoll({ status: 409, body: { error: 'hello_required' } })
    await settle()
    h.fake.release(CONNECTOR_PATHS.hello)
    await settle(1_000)
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll).at(-1)?.body).toMatchObject({ helloRev: 2 })
    client.stop()
  })

  it('says a change made during its first hello once that hello lands, not a held poll later', async () => {
    h.fake.holdAfter.add(CONNECTOR_PATHS.hello)
    const { client, machine } = startClient()
    await settle()
    // Something the hello reads (a bot's GitHub installs) arrives while it is on its way.
    machine.botList = [FAKE_BOT]
    client.sayChanged()
    h.fake.release(CONNECTOR_PATHS.hello)
    await settle()
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.fake.hellos.at(-1)).toMatchObject({ bots: [FAKE_BOT] })
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(1)
    client.stop()
  })

  it('settles a recovered delivery whose earlier run fails as unknown, never running it again', async () => {
    const seam = fakeSeam()
    seam.calls.recorded.mockRejectedValueOnce(new Error('launch_failed'))
    const { client, calls } = startClient(seam)
    await settle()
    poll([], { unsettled: [{ deliveryId: 'd1', conversation }] })
    await settle()
    expect(h.fake.acks).toEqual([
      { deliveryId: 'd1', step: 'done', result: { outcome: 'unknown', reason: 'launch_failed' } }
    ])
    expect(calls.send).not.toHaveBeenCalled()
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
    h.fake.holdBefore.add(CONNECTOR_PATHS.acks)
    sent.resolve({ outcome: 'accepted' })
    await settle()
    machine.botList = [FAKE_BOT]
    poll([], { unsettled: [{ deliveryId: 'd1', conversation }] })
    await settle()
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.fake.hellos.at(-1)).toMatchObject({ bots: [FAKE_BOT] })
    h.fake.release(CONNECTOR_PATHS.acks)
    await settle(5_000)
    expect(h.fake.acks).toContainEqual({
      deliveryId: 'd1',
      step: 'done',
      result: { outcome: 'accepted' }
    })
    client.stop()
  })

  it('says hello again after a failed one, even when what it says went back to the last accepted hello', async () => {
    const { client, machine, emit } = startClient()
    await settle()
    h.fake.forced.set(CONNECTOR_PATHS.hello, { status: 503 })
    machine.botList = [FAKE_BOT]
    poll([])
    await settle()
    machine.botList = []
    h.fake.forced.delete(CONNECTOR_PATHS.hello)
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
    expect(h.fake.events).toContainEqual(expect.objectContaining({ kind: 'turn-ended', turnId: 4 }))
    client.stop()
  })

  it('posts a reply to Orca Cloud with its turn, and a resend with the same id posts once', async () => {
    const { client } = startClient()
    await settle()
    const body = { replyId: 'r1', conversation, turnId: 7, text: 'done' }
    await expect(client.reply(body)).resolves.toEqual({
      ok: true,
      value: { status: 'posted', messageId: '1793.0042' }
    })
    await client.reply(body)
    expect([...h.fake.replies.values()]).toEqual([{ v: 1, ...body }])
    client.stop()
  })

  it('sends a review only to a cloud whose last hello answer listed it, and folds it into the text otherwise', async () => {
    const { client, machine } = startClient()
    await settle()
    const review = {
      comments: [
        { path: 'src/a.ts', line: 3, body: 'Off by one.' },
        { path: 'src/b.ts', line: 9, side: 'LEFT' as const, body: 'Was this needed?' }
      ]
    }
    await client.reply({ replyId: 'r1', conversation, turnId: 7, text: 'Two notes.', review })
    expect(h.fake.replies.get('r1')).toEqual({
      v: 1,
      replyId: 'r1',
      conversation,
      turnId: 7,
      text: 'Two notes.\n\nsrc/a.ts:3: Off by one.\nsrc/b.ts:9 (old): Was this needed?'
    })

    h.fake.features = ['review']
    machine.botList = [FAKE_BOT]
    client.sayChanged()
    await settle()
    await client.reply({ replyId: 'r2', conversation, turnId: 7, text: 'Two notes.', review })
    expect(h.fake.replies.get('r2')).toEqual({
      v: 1,
      replyId: 'r2',
      conversation,
      turnId: 7,
      text: 'Two notes.',
      review
    })
    client.stop()
  })

  it('retries a busy cloud for a reply only after its Retry-After, with the same reply id', async () => {
    const { client } = startClient()
    await settle()
    h.fake.forced.set(CONNECTOR_PATHS.replies, { status: 429, headers: { 'retry-after': '20' } })
    const sent = client.reply({ replyId: 'r1', conversation, turnId: 7, text: 'done' })
    await settle(19_000)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.replies)).toHaveLength(1)
    h.fake.forced.delete(CONNECTOR_PATHS.replies)
    await settle(2_000)
    await expect(sent).resolves.toMatchObject({ ok: true })
    expect([...h.fake.replies.keys()]).toEqual(['r1'])
    client.stop()
  })

  it('says hello again after a poll answer is lost, spread like a drain so a crashed instance never brings every host back at once', async () => {
    const { client } = startClient()
    await settle()
    expect(h.fake.events).toHaveLength(1)
    // Not the contract: reads like no answer at all.
    h.fake.answerPoll({ status: 200, body: {} })
    // random() is 0.5: half the 20 s spread, then the hello and its snapshot.
    await settle(9_900)
    expect(h.fake.hellos).toHaveLength(1)
    expect(h.fake.events).toHaveLength(1)
    await settle(200)
    expect(h.fake.hellos).toHaveLength(2)
    expect(h.fake.events).toEqual([
      { kind: 'snapshot', conversations: [] },
      { kind: 'snapshot', conversations: [] }
    ])
    client.stop()
  })

  it('never takes a hello whose answer is not the contract', async () => {
    const { client } = startClient()
    h.fake.forced.set(CONNECTOR_PATHS.hello, { status: 204 })
    await settle(5_000)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll)).toHaveLength(0)
    h.fake.forced.delete(CONNECTOR_PATHS.hello)
    await settle(30_000)
    expect(h.fake.requestsTo(CONNECTOR_PATHS.poll).length).toBeGreaterThan(0)
    client.stop()
  })
})
