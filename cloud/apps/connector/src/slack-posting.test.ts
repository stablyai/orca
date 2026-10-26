import { CONNECTOR_PATHS, ConnectorPollResponseSchema } from '@orca-cloud/connector-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupConnectorHarnesses } from './connector-server-harness.test-fixture.js'
import {
  BOT,
  CHANNEL,
  createSlackHarness,
  OWNER,
  conversation,
  EXTERNAL_ID,
  project,
  startedThread,
  TEAM,
  THREAD,
  TURN,
  turnEnded,
  turnStarted
} from './slack-harness.test-fixture.js'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { SlackInstalls } from './slack-installs.js'
import { SlackPostWorker } from './slack-post-worker.js'
import { SlackPosts } from './slack-posts.js'
import { createSlackWebApi } from './slack-web-api.js'

afterEach(async () => {
  await cleanupConnectorHarnesses()
  vi.unstubAllGlobals()
})

describe('Slack thread status and posts', () => {
  it('edits one status message as the turn moves, and posts the last message when the agent didn’t reply', async () => {
    const harness = await startedThread()
    expect(await harness.status()).toBe('Waiting for your Orca on build-box…')
    await harness.machine.ack([{ deliveryId: harness.start?.deliveryId, step: 'received' }])
    await harness.events(turnStarted)
    expect(await harness.status()).toBe('Working on build-box…')
    await harness.events({
      kind: 'prompt',
      conversation,
      paneKey: 'pane-1',
      prompt: { kind: 'approval', promptId: 'p1', tool: 'Bash', options: [] }
    })
    expect(await harness.status()).toBe('Waiting for your answer in Orca on build-box.')
    await harness.events(turnEnded)
    expect(await harness.status()).toBe('Done on build-box.')
    const [fallback] = await harness.database.query(
      'SELECT body, next_at FROM connector_slack_posts WHERE post_id = ?',
      [`fallback:${EXTERNAL_ID}:${TURN}`]
    )
    expect(JSON.parse(String(fallback?.body)).text).toBe('Fixed &lt;!channel&gt; &amp; done')
    expect(Number(fallback?.next_at)).toBe(harness.now() + 5_000)
  })

  it('a reply from the agent posts once and cancels the turn’s fallback; another machine can’t reply', async () => {
    const harness = await startedThread()
    await harness.events(turnStarted, turnEnded)
    expect(await (await harness.reply('r1', 'Here you go')).json()).toEqual({ status: 'queued' })
    expect(await (await harness.reply('r1', 'Here you go')).json()).toEqual({ status: 'queued' })
    const states = Object.fromEntries(
      (await harness.posts()).map((post) => [post.post_id, post.state])
    )
    expect(states[`fallback:${EXTERNAL_ID}:${TURN}`]).toBe('cancelled')
    expect(Object.keys(states).filter((id) => id.startsWith('reply:'))).toHaveLength(1)

    const stranger = await harness.machineWith('user-1', [])
    expect((await harness.reply('r2', 'hi', stranger)).status).toBe(403)

    await harness.pass()
    await harness.pass()
    expect(await (await harness.reply('r1', 'Here you go')).json()).toEqual({
      status: 'posted',
      messageId: expect.any(String)
    })
  })

  it("never posts another source's output to a Slack thread with the same id", async () => {
    const harness = await startedThread()
    const other = { source: 'discord', externalId: EXTERNAL_ID }
    await harness.events(turnStarted, { ...turnEnded, conversation: other })
    const reply = { v: 1, replyId: 'r1', conversation: other, turnId: TURN, text: 'hi' }
    expect((await harness.machine.call(CONNECTOR_PATHS.replies, reply)).status).toBe(403)
    expect((await harness.posts()).filter((post) => post.kind === 'message')).toEqual([])
    expect(await harness.status()).toBe('Working on build-box…')
  })

  it('shows a refused start', async () => {
    const harness = await startedThread()
    await harness.machine.ack([
      {
        deliveryId: harness.start?.deliveryId,
        step: 'done',
        result: { outcome: 'refused', reason: 'no_such_project' }
      }
    ])
    // A code with no line of its own reads generically; the code itself stays out of the channel.
    expect(await harness.status()).toBe('Your Orca on build-box couldn’t take this.')
  })

  it('records a refusal whose code is an inherited property name, and reads it generically', async () => {
    for (const reason of ['__proto__', 'toString']) {
      const harness = await startedThread()
      const response = await harness.machine.ack([
        {
          deliveryId: harness.start?.deliveryId,
          step: 'done',
          result: { outcome: 'refused', reason }
        }
      ])
      expect(response.status).toBe(204)
      const [row] = await harness.database.query('SELECT state FROM connector_inbox')
      expect(row?.state).toBe('done')
      expect(await harness.status()).toBe('Your Orca on build-box couldn’t take this.')
    }
  })

  it('shows a turn the machine can no longer vouch for', async () => {
    const harness = await startedThread()
    await harness.machine.ack([
      { deliveryId: harness.start?.deliveryId, step: 'done', result: { outcome: 'accepted' } }
    ])
    await harness.events(turnStarted)
    await harness.events({ kind: 'snapshot', conversations: [] })
    expect(await harness.status()).toBe('No update from your Orca; check Orca.')
  })

  it('sends the reaction and status, then edits the status in place', async () => {
    const harness = await startedThread()
    // One post per channel per pass, in queue order.
    await harness.pass()
    await harness.pass()
    const sent = harness.fake.take()
    expect(sent).toEqual([
      { method: 'reactions.add', args: { channel: CHANNEL, name: 'eyes', timestamp: THREAD } },
      expect.objectContaining({ method: 'chat.postMessage' })
    ])
    const postArgs = sent[1]?.args
    expect(postArgs).toMatchObject({
      channel: CHANNEL,
      thread_ts: THREAD,
      text: 'Waiting for your Orca on build-box…',
      metadata: { event_type: 'orca_post', event_payload: { post_id: `status:${EXTERNAL_ID}` } }
    })

    await harness.events(turnStarted)
    await harness.pass()
    expect(harness.fake.take()).toEqual([
      {
        method: 'chat.update',
        args: {
          channel: CHANNEL,
          ts: expect.any(String),
          text: 'Working on build-box…'
        }
      }
    ])
  })

  it('a status changed while it was sending gets one more edit', async () => {
    const harness = await startedThread()
    await harness.pass()
    const posts = new SlackPosts(harness.database, harness.now)
    const [claimed] = await posts.claim()
    await harness.events(turnStarted)
    expect(claimed).toBeDefined()
    if (claimed) {
      await posts.posted(claimed, '1800000100.000001')
    }
    const status = (await harness.posts()).find((post) => post.post_id === `status:${EXTERNAL_ID}`)
    expect(status).toMatchObject({ state: 'queued', slack_ts: '1800000100.000001' })
  })

  it('waits out Slack’s rate limit for the whole channel, posts queued later included', async () => {
    const harness = await startedThread()
    harness.fake.respond(
      'reactions.add',
      new Response(null, { status: 429, headers: { 'retry-after': '30' } })
    )
    await harness.pass()
    expect(harness.fake.take().map((call) => call.method)).toEqual(['reactions.add'])
    await harness.reply('r1', 'later')
    await harness.pass()
    expect(harness.fake.take()).toEqual([])
    harness.advance(30_000)
    await harness.pass()
    expect(harness.fake.take().map((call) => call.method)).toEqual(['reactions.add'])
  })

  it('treats internal_error as maybe-posted and checks before sending again', async () => {
    const harness = await startedThread()
    await harness.pass()
    harness.fake.respond('chat.postMessage', Response.json({ ok: false, error: 'internal_error' }))
    await harness.pass()
    harness.advance(120_000)
    harness.fake.respond('conversations.replies', Response.json({ ok: true, messages: [] }))
    await harness.pass()
    expect(harness.fake.take().map((call) => call.method)).toEqual([
      'reactions.add',
      'chat.postMessage',
      'conversations.replies',
      'chat.postMessage'
    ])
  })

  it('a post left mid-send is found by its metadata, re-sent when absent, uncertain when unreadable', async () => {
    const harness = await startedThread()
    harness.fake.respond('reactions.add', Response.json({ ok: false, error: 'already_reacted' }))
    harness.fake.respond('chat.postMessage', new Response(null, { status: 502 }))
    await harness.pass()
    await harness.pass()
    harness.fake.take()
    const states = async () =>
      Object.fromEntries((await harness.posts()).map((post) => [post.post_id, post.state]))
    expect(await states()).toEqual({
      [`eyes:${TEAM}:${CHANNEL}:${THREAD}`]: 'posted',
      [`status:${EXTERNAL_ID}`]: 'sending'
    })

    // The found copy may predate the row's text, so the status is edited once more.
    harness.advance(120_000)
    harness.fake.respond(
      'conversations.replies',
      Response.json({
        ok: true,
        messages: [{ ts: THREAD }],
        has_more: true,
        response_metadata: { next_cursor: 'c2' }
      }),
      Response.json({
        ok: true,
        messages: [
          {
            ts: '1800000100.000009',
            metadata: {
              event_type: 'orca_post',
              event_payload: { post_id: `status:${EXTERNAL_ID}` }
            }
          }
        ]
      })
    )
    await harness.pass()
    await harness.pass()
    expect(harness.fake.take()).toEqual([
      expect.objectContaining({ method: 'conversations.replies' }),
      expect.objectContaining({
        method: 'conversations.replies',
        args: expect.objectContaining({ cursor: 'c2' })
      }),
      expect.objectContaining({
        method: 'chat.update',
        args: expect.objectContaining({ ts: '1800000100.000009' })
      })
    ])
    expect(await states()).toMatchObject({ [`status:${EXTERNAL_ID}`]: 'posted' })

    await harness.reply('r1', 'one')
    harness.fake.respond('chat.postMessage', new Response(null, { status: 502 }))
    await harness.pass()
    harness.advance(120_000)
    harness.fake.respond('conversations.replies', Response.json({ ok: true, messages: [] }))
    await harness.pass()
    expect(harness.fake.take().map((call) => call.method)).toEqual([
      'chat.postMessage',
      'conversations.replies',
      'chat.postMessage'
    ])

    await harness.reply('r2', 'two')
    harness.fake.respond('chat.postMessage', new Response(null, { status: 502 }))
    await harness.pass()
    harness.advance(120_000)
    const morePages = () =>
      Response.json({
        ok: true,
        messages: [],
        has_more: true,
        response_metadata: { next_cursor: 'n' }
      })
    harness.fake.respond('conversations.replies', morePages(), morePages(), morePages())
    await harness.pass()
    expect((await states())[`reply:${harness.machine.hostId}:r2`]).toBe('uncertain')
  })

  it('a sender whose lease ran out changes nothing', async () => {
    const harness = await startedThread()
    const posts = new SlackPosts(harness.database, harness.now)
    const [first] = await posts.claim()
    harness.advance(120_000)
    const [second] = await posts.claim()
    expect(second?.postId).toBe(first?.postId)
    if (first) {
      await posts.posted(first, '1800000100.000001')
    }
    expect((await harness.posts()).find((post) => post.post_id === first?.postId)?.state).toBe(
      'sending'
    )
  })

  it('posts a fallback for every turn that ended in a batch, and none for an empty message', async () => {
    const harness = await startedThread()
    await harness.events(
      turnStarted,
      turnEnded,
      { ...turnStarted, at: TURN + 10_000 },
      { ...turnEnded, turnId: TURN + 10_000, at: TURN + 20_000, lastAssistantMessage: 'second' },
      { ...turnStarted, at: TURN + 30_000 },
      { ...turnEnded, turnId: TURN + 30_000, at: TURN + 40_000, lastAssistantMessage: '  ' }
    )
    expect(
      (await harness.posts())
        .map((post) => String(post.post_id))
        .filter((id) => id.startsWith('fallback:'))
    ).toEqual([`fallback:${EXTERNAL_ID}:${TURN}`, `fallback:${EXTERNAL_ID}:${TURN + 10_000}`])
  })

  it('a turn the agent already replied in gets no fallback', async () => {
    const harness = await startedThread()
    await harness.reply('r1', 'Here you go')
    await harness.events(turnStarted, turnEnded)
    expect(
      (await harness.posts()).some((post) => String(post.post_id).startsWith('fallback:'))
    ).toBe(false)
  })

  it('an old claim can’t finish a newer claim of the same post, and sent text is dropped', async () => {
    const harness = await startedThread()
    const posts = new SlackPosts(harness.database, harness.now)
    await harness.pass()
    const [first] = await posts.claim()
    harness.advance(120_000)
    const [recovered] = await posts.claim()
    if (!first || !recovered) {
      throw new Error('expected claims')
    }
    await posts.found(recovered, '1800000100.000001')
    harness.advance(1_000)
    const [edit] = await posts.claim()
    await posts.settle(first, 'failed')
    expect((await harness.posts()).find((post) => post.post_id === edit?.postId)?.state).toBe(
      'sending'
    )
    if (edit) {
      await posts.posted(edit)
    }

    await harness.reply('r1', 'secret reply')
    harness.advance(1_000)
    await harness.pass()
    await harness.pass()
    const reply = (await harness.posts()).find((post) => String(post.post_id).startsWith('reply:'))
    expect(reply).toMatchObject({ state: 'posted', body: '{}' })
  })

  it('a database error after Slack took the post leaves it to the history check, not failed', async () => {
    const harness = await startedThread()
    let failNext = true
    const inner = harness.database
    const flaky: CloudDatabase = {
      dialect: inner.dialect,
      query: async (sql, params) => {
        if (failNext && sql.includes("THEN 'posted'")) {
          failNext = false
          throw new Error('connection lost')
        }
        return await inner.query(sql, params)
      },
      transaction: (run) => inner.transaction(run),
      lockQuotaScope: (key) => inner.lockQuotaScope(key),
      tryLockScope: (key) => inner.tryLockScope(key),
      tryLockSharedScope: (key) => inner.tryLockSharedScope(key),
      close: () => inner.close()
    }
    const worker = new SlackPostWorker({
      database: harness.database,
      posts: new SlackPosts(flaky, harness.now),
      installs: new SlackInstalls(harness.tokenKey),
      api: createSlackWebApi()
    })
    await expect(worker.sendDue()).rejects.toThrow('connection lost')
    expect(
      (await harness.posts()).find((post) => String(post.post_id).startsWith('eyes:'))?.state
    ).toBe('sending')
  })

  it('a status whose first post is uncertain stays uncertain when its text changes', async () => {
    const harness = await startedThread()
    await harness.pass()
    harness.fake.respond('chat.postMessage', new Response(null, { status: 502 }))
    await harness.pass()
    harness.advance(120_000)
    harness.fake.respond(
      'conversations.replies',
      Response.json({ ok: false, error: 'ratelimited' })
    )
    await harness.pass()
    await harness.events(turnStarted)
    harness.fake.take()
    await harness.pass()
    expect(harness.fake.take()).toEqual([])
    expect(
      (await harness.posts()).find((post) => post.post_id === `status:${EXTERNAL_ID}`)?.state
    ).toBe('uncertain')
  })

  it('sends an ephemeral reply to its one reader: in the channel for a top-level mention, in the thread for a threaded one; user_not_in_channel is final', async () => {
    const harness = await createSlackHarness()
    await harness.message({ user: 'U7', text: `<@${BOT}> fix it`, ts: THREAD })
    await harness.message({
      user: 'U8',
      text: `<@${BOT}> fix it`,
      ts: '1800000000.000200',
      thread_ts: THREAD
    })
    harness.fake.respond('chat.postEphemeral', Response.json({ ok: true, message_ts: '1' }))
    harness.fake.respond(
      'chat.postEphemeral',
      Response.json({ ok: false, error: 'user_not_in_channel' })
    )
    await harness.edge.worker.sendDue()
    await harness.edge.worker.sendDue()
    expect(harness.fake.take()).toEqual([
      {
        method: 'chat.postEphemeral',
        args: { channel: CHANNEL, user: 'U7', text: expect.stringContaining('Ask an admin') }
      },
      {
        method: 'chat.postEphemeral',
        args: {
          channel: CHANNEL,
          user: 'U8',
          text: expect.stringContaining('Ask an admin'),
          thread_ts: THREAD
        }
      }
    ])
    expect((await harness.posts()).map((post) => post.state)).toEqual(['posted', 'failed'])
  })

  it('edits a working or waiting status to offline when the next message expires undelivered', async () => {
    const harness = await startedThread()
    await harness.machine.ack([
      { deliveryId: harness.start?.deliveryId, step: 'done', result: { outcome: 'accepted' } }
    ])
    await harness.events(turnStarted, {
      kind: 'prompt',
      conversation,
      paneKey: 'pane-1',
      prompt: { kind: 'approval', promptId: 'p1', tool: 'Bash', options: [] }
    })
    await harness.pass()
    await harness.pass()
    harness.fake.take()
    await harness.message({ text: 'still there?', ts: '1800000000.000200', thread_ts: THREAD })
    harness.advance(5 * 60_000 + 1)
    await harness.runtime.inbox.expireDue(harness.edge.onExpired)
    await harness.pass()
    await harness.pass()
    expect(harness.fake.take().filter((call) => call.method === 'chat.update')).toEqual([
      {
        method: 'chat.update',
        args: {
          channel: CHANNEL,
          ts: expect.any(String),
          text: `Couldn’t reach <@${OWNER}>’s Orca on build-box. Send again when it’s back.`
        }
      }
    ])
  })
})
