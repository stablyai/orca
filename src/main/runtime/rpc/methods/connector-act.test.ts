import { describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../core'
import { mapRuntimeError } from '../responses/rpc-response'
import { CONNECTOR_ACT_METHOD, ConnectorActError } from './connector-act'

const sessionBots = vi.hoisted(() => new Map<string, { id: string }>())
vi.mock('../../../bots/bot-session-tabs', () => ({
  botOfSession: (_bots: unknown, sessionId: string) => sessionBots.get(sessionId) ?? null
}))

const notedPosts = vi.hoisted((): (string | undefined)[] => [])
vi.mock('./orchestration/messaging/bot-request-outcome', () => ({
  noteBotRequestPost: async (_runtime: unknown, _sessionId: string, ref: string | undefined) => {
    notedPosts.push(ref)
  }
}))

// Every chat here is its owner's own.
vi.mock('./orchestration/messaging/bot-recipient', () => ({
  readBotTurn: async () => ({ turn: { askers: [{ kind: 'owner' }] } })
}))

const [act] = eraseRpcMethods([CONNECTOR_ACT_METHOD])

function actContext(cloud: {
  features: string[] | null
  answers?: unknown[]
  /** A headless Orca server's: its signed-out copy names it. */
  headless?: boolean
  status?: string
  // The cloud conversation the calling chat answers, if it answers one.
  conversation?: { source: string; externalId: string }
}): {
  context: RpcContext
  calls: { path: string; body: unknown }[]
} {
  const calls: { path: string; body: unknown }[] = []
  const runtime = {
    bots: { enabled: () => true, list: () => [] },
    servesWithoutWindow: () => cloud.headless === true,
    getOrchestrationDb: () => ({}),
    lookAround: {
      botOfLook: (sessionId: string) => (sessionId === 'look-session' ? 'b1' : null),
      botOfTidyUp: () => null
    },
    getExternalConversationSeam: () => ({
      replyTarget: () => (cloud.conversation ? { key: cloud.conversation, turnId: 1 } : null)
    }),
    getConnectorCloud: () => ({
      cloudFeatures: () => (cloud.features ? new Set(cloud.features) : null),
      status: () => cloud.status ?? 'ok',
      call: async (path: string, body: unknown) => {
        calls.push({ path, body })
        return (
          cloud.answers?.shift() ?? { ok: false, status: null, error: null, retryAfterMs: null }
        )
      }
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connector.act reads only these runtime services.
  return { context: { runtime } as unknown as RpcContext, calls }
}

const run = (input: Record<string, unknown>, context: RpcContext) =>
  Promise.resolve().then(() => act!.handler(act!.params!.parse(input), context))

describe('connector.act', () => {
  sessionBots.set('bot-session', { id: 'b1' })

  it('acts as the bot whose home the calling session is in, and passes the answer on', async () => {
    const answer = { ok: true, result: { matches: [] } }
    const { context, calls } = actContext({
      features: ['actions'],
      answers: [{ ok: true, value: answer }]
    })
    await expect(
      run({ sessionId: 'bot-session', verb: 'find', ref: '#infra' }, context)
    ).resolves.toEqual(answer)
    expect(calls).toEqual([
      {
        path: '/v1/connector/actions',
        body: { v: 1, botId: 'b1', verb: 'find', ref: '#infra', args: {} }
      }
    ])
  })

  it('names the conversation and turn the calling chat answers, so the cloud keeps a lookup to its workspace', async () => {
    const conversation = { source: 'slack', externalId: 'T1:C1:1.2:U0BOT' }
    const { context, calls } = actContext({
      features: ['actions'],
      answers: [{ ok: true, value: { ok: true, result: { matches: [] } } }],
      conversation
    })
    await run({ sessionId: 'bot-session', verb: 'find', ref: '@dana' }, context)
    expect(calls[0]?.body).toEqual({
      v: 1,
      botId: 'b1',
      verb: 'find',
      ref: '@dana',
      args: {},
      conversation,
      turnId: 1
    })
  })

  it('lets a look-around run read, and refuses its post before calling the cloud', async () => {
    sessionBots.set('look-session', { id: 'b1' })
    const answer = { ok: true, result: { messages: [] } }
    const { context, calls } = actContext({
      features: ['actions'],
      answers: [{ ok: true, value: answer }]
    })
    await expect(
      run({ sessionId: 'look-session', verb: 'read', ref: 'slack:T1:C1' }, context)
    ).resolves.toEqual(answer)
    await expect(
      run(
        { sessionId: 'look-session', verb: 'post', ref: 'slack:T1:C1', args: { text: 'hi' } },
        context
      )
    ).rejects.toMatchObject({ code: 'look_around_reads_only' })
    expect(calls).toHaveLength(1)
  })

  it('notes a post the source took for a bot request, never one it refused', async () => {
    const refused = { ok: false, refusal: 'not_found', message: "The bot can't see this channel." }
    const { context } = actContext({
      features: ['actions'],
      answers: [
        { ok: true, value: refused },
        { ok: true, value: { ok: true, result: {} } }
      ]
    })
    notedPosts.length = 0
    await run({ sessionId: 'bot-session', verb: 'post', ref: 'slack:T:C:1', text: 'hi' }, context)
    expect(notedPosts).toEqual([])
    await run({ sessionId: 'bot-session', verb: 'post', ref: 'slack:T:C:1', text: 'hi' }, context)
    expect(notedPosts).toEqual(['slack:T:C:1'])
  })

  it('posts as the owner’s turn only for the chat that is asking', async () => {
    const { context, calls } = actContext({
      features: ['actions'],
      answers: [
        { ok: true, value: { ok: true, result: {} } },
        { ok: true, value: { ok: true, result: {} } }
      ]
    })
    const asking = (sessionId: string) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the caller's session is read.
      ({ ...context, orchestrationCaller: { sessionId } }) as unknown as RpcContext
    const post = { sessionId: 'bot-session', verb: 'post', ref: 'slack:T:C:1', text: 'hi' }
    await run(post, asking('bot-session'))
    await run(post, asking('another-bot-session'))
    expect(calls.map((call) => call.body)).toEqual([
      expect.objectContaining({ turnFor: 'owner' }),
      expect.objectContaining({ turnFor: 'none' })
    ])
  })

  it('refuses a session in no bot home', async () => {
    const { context } = actContext({ features: ['actions'] })
    await expect(run({ sessionId: 'other', verb: 'capabilities' }, context)).rejects.toMatchObject({
      code: 'not_a_bot_session'
    })
  })

  it('refuses before calling a cloud that predates actions, or with no client running', async () => {
    const older = actContext({ features: ['review'] })
    await expect(
      run({ sessionId: 'bot-session', verb: 'capabilities' }, older.context)
    ).rejects.toMatchObject({ code: 'cloud_lacks_actions' })
    const off = actContext({ features: null })
    await expect(
      run({ sessionId: 'bot-session', verb: 'capabilities' }, off.context)
    ).rejects.toMatchObject({ code: 'connector_not_connected' })
    expect([...older.calls, ...off.calls]).toEqual([])
  })

  it('sends a set only to a cloud that takes one, and says a lost answer may have changed it', async () => {
    const set = {
      sessionId: 'bot-session',
      verb: 'set',
      ref: 'ENG-1',
      args: { fields: { state: 'Done' } }
    }
    const older = actContext({ features: ['actions'] })
    await expect(run(set, older.context)).rejects.toMatchObject({ code: 'cloud_lacks_set' })
    expect(older.calls).toEqual([])
    // A set whose answer never came may have changed the issue.
    const lost = actContext({ features: ['actions', 'set'], answers: [] })
    await expect(run(set, lost.context)).rejects.toMatchObject({ code: 'connector_set_unknown' })
    // Sent once: a retry could undo a change someone made since.
    expect(lost.calls).toHaveLength(1)
  })

  it('sends a post that makes an issue only to a cloud that takes one', async () => {
    const older = actContext({ features: ['actions', 'set'] })
    await expect(
      run(
        {
          sessionId: 'bot-session',
          verb: 'post',
          ref: 'ENG',
          args: { text: 'x', title: 'y', postId: 'p' }
        },
        older.context
      )
    ).rejects.toMatchObject({ code: 'cloud_lacks_create' })
    expect(older.calls).toEqual([])
  })

  it('sends staged reply files only to a cloud that posts several at once', async () => {
    const stage = {
      sessionId: 'bot-session',
      verb: 'reply',
      args: { upload: { name: 'a.png', size: 1 }, postId: 'p1', stage: true }
    }
    const older = actContext({ features: ['actions'] })
    await expect(run(stage, older.context)).rejects.toMatchObject({
      code: 'cloud_lacks_reply_files'
    })
    expect(older.calls).toEqual([])
  })

  it("sends a file's upload, a staged attach or a streamed download only to a cloud taking direct files", async () => {
    const older = actContext({ features: ['actions', 'reply.files'] })
    for (const call of [
      { verb: 'reply', args: { upload: { name: 'a.png', size: 1 }, postId: 'p1', stage: true } },
      {
        verb: 'attach',
        ref: 'slack:T1:C1',
        args: { upload: { name: 'a.png', size: 1 }, postId: 'p1', stage: true }
      },
      { verb: 'attach', ref: 'slack:T1:C1', args: { files: ['p1'], postId: 'p2' } },
      { verb: 'read', ref: 'slack:T1:C1::1.2', args: { download: 'F1', stream: true } }
    ]) {
      await expect(run({ sessionId: 'bot-session', ...call }, older.context)).rejects.toMatchObject(
        { code: 'cloud_lacks_direct_files' }
      )
    }
    expect(older.calls).toEqual([])
  })

  it('schedules a post only with a cloud that can, and never posts it now instead', async () => {
    const later = {
      sessionId: 'bot-session',
      verb: 'post',
      ref: 'slack:T1:C1',
      args: { text: 'standup in 10', postId: 'p1', postAt: 1_900_000_000 }
    }
    const older = actContext({ features: ['actions'] })
    await expect(run(later, older.context)).rejects.toMatchObject({ code: 'cloud_lacks_schedule' })
    expect(older.calls).toEqual([])
    const newer = actContext({
      features: ['actions', 'post.schedule'],
      answers: [{ ok: true, value: { ok: true, result: { note: 'Scheduled.' } } }]
    })
    await run(later, newer.context)
    expect(newer.calls[0]?.body).toMatchObject({ verb: 'post', args: later.args })
  })

  it('sends Slack’s own verbs only to a cloud that takes them', async () => {
    const pin = { sessionId: 'bot-session', verb: 'pin', ref: 'slack:T1:C1::1.1', args: {} }
    const older = actContext({ features: ['actions'] })
    await expect(run(pin, older.context)).rejects.toMatchObject({ code: 'cloud_lacks_slack_tools' })
    expect(older.calls).toEqual([])
    const newer = actContext({
      features: ['actions', 'slack.tools'],
      answers: [{ ok: true, value: { ok: true, result: {} } }]
    })
    await run(pin, newer.context)
    expect(newer.calls[0]?.body).toMatchObject({ verb: 'pin', ref: 'slack:T1:C1::1.1' })
  })

  it('sends a search only to a cloud that takes one', async () => {
    const find = {
      sessionId: 'bot-session',
      verb: 'find',
      ref: 'ENG',
      args: { search: { state: 'open' } }
    }
    const older = actContext({ features: ['actions'] })
    await expect(run(find, older.context)).rejects.toMatchObject({ code: 'cloud_lacks_search' })
    expect(older.calls).toEqual([])
    const newer = actContext({
      features: ['actions', 'find.search'],
      answers: [{ ok: true, value: { ok: true, result: { matches: [] } } }]
    })
    await expect(run(find, newer.context)).resolves.toEqual({ ok: true, result: { matches: [] } })
    expect(newer.calls).toHaveLength(1)
  })

  it('searches the Slack workspace of the conversation it answers when no place is named', async () => {
    const find = { sessionId: 'bot-session', verb: 'find', args: { search: { text: 'deploy' } } }
    const answered = actContext({
      features: ['actions', 'find.search'],
      answers: [{ ok: true, value: { ok: true, result: { matches: [] } } }],
      conversation: { source: 'slack', externalId: 'T1:C1:1.2:U0BOT' }
    })
    await run(find, answered.context)
    expect(answered.calls[0]?.body).toMatchObject({ ref: 'slack:T1:workspace' })
    const unanswered = actContext({ features: ['actions', 'find.search'] })
    await expect(run(find, unanswered.context)).rejects.toThrow(
      'Name the Slack workspace to search'
    )
    expect(unanswered.calls).toEqual([])
  })

  it('retries a post under its postId, and says a post whose answer never came may have gone', async () => {
    const { context, calls } = actContext({ features: ['actions'] })
    const post = {
      sessionId: 'bot-session',
      verb: 'post',
      ref: 'slack:T1:C1',
      args: { text: 'hi', postId: 'p1' }
    }
    await expect(run(post, context)).rejects.toMatchObject({
      code: 'connector_post_unknown',
      message: expect.stringContaining('Read slack:T1:C1 before trying again')
    })
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      expect(call.body).toMatchObject({ args: { postId: 'p1' } })
    }
    const attach = {
      ...post,
      verb: 'attach',
      args: { files: ['s1'], postId: 'p2' }
    }
    const direct = actContext({ features: ['actions', 'reply.files', 'files.direct'] })
    await expect(run(attach, direct.context)).rejects.toMatchObject({
      code: 'connector_post_unknown',
      message: expect.stringContaining('the file may have gone')
    })
  })

  it('says an edit whose answer never came may have gone through, and keeps it from a look-around', async () => {
    const { context } = actContext({ features: ['actions'] })
    const edit = { verb: 'edit', ref: 'slack:T1:C1::1.2', args: { text: 'fixed' } }
    await expect(run({ sessionId: 'bot-session', ...edit }, context)).rejects.toMatchObject({
      code: 'connector_unavailable',
      message: expect.stringContaining('the edit may have gone through. Read slack:T1:C1::1.2')
    })
    sessionBots.set('look-session', { id: 'b1' })
    await expect(run({ sessionId: 'look-session', ...edit }, context)).rejects.toMatchObject({
      code: 'look_around_reads_only'
    })
  })

  it.each<[string, boolean, string[] | null]>([
    ['signed-out', true, null],
    ['needs-sign-in', true, null],
    // Orca Cloud refused the sign-in after its hello: its features stay cached.
    ['needs-sign-in', true, ['actions']],
    ['signed-out', false, null],
    ['needs-sign-in', false, ['actions']]
  ])(
    'refuses before calling the cloud while the host is not signed in (%s, headless %s, features %j)',
    async (status, headless, features) => {
      const { context, calls } = actContext({ features, status, headless })
      const refused = run({ sessionId: 'bot-session', verb: 'places' }, context)
      await expect(refused).rejects.toMatchObject({ code: 'connector_not_connected' })
      const error: unknown = await refused.catch((caught: unknown) => caught)
      const message = error instanceof Error ? error.message : ''
      if (headless) {
        expect(message).toMatch(
          /^This Orca server \(.+\) isn't signed in to Orca Cloud, so it can't reach Orca Cloud\. Your owner can sign it in by running `orca auth login` in a terminal on .+ Then try again\.$/
        )
      } else {
        expect(message).toBe(
          "This computer isn't signed in to Orca Cloud: sign in to Orca Cloud on this computer, then try again."
        )
      }
      expect(calls).toEqual([])
    }
  )

  it.each([
    { status: 401, error: 'signed_out' },
    // The connector-token route refused the sign-in after the session refresh.
    { status: 401, error: 'invalid_token', sessionRefused: true as const }
  ])('names a headless server when the cloud refuses its sign-in (%j)', async (failure) => {
    const { context } = actContext({
      features: ['actions'],
      headless: true,
      answers: [{ ok: false, retryAfterMs: null, ...failure }]
    })
    await expect(
      run({ sessionId: 'bot-session', verb: 'read', ref: 'slack:T1:C1' }, context)
    ).rejects.toMatchObject({
      code: 'connector_not_connected',
      message: expect.stringContaining('`orca auth login` in a terminal on')
    })
  })

  it("says Orca isn't connected only when this host has no Orca Cloud features and is signed in", async () => {
    const { context } = actContext({ features: null, status: 'ok' })
    await expect(run({ sessionId: 'bot-session', verb: 'places' }, context)).rejects.toMatchObject({
      code: 'connector_not_connected',
      message:
        "Orca isn't connected to Orca Cloud: sign in to Orca Cloud and connect a bot to Slack, Linear or GitHub, then try again."
    })
  })

  it.each([
    [{ status: 404, error: 'unknown_bot' }, 'bot_not_in_cloud', "isn't on Orca Cloud"],
    [{ status: 400, error: 'invalid_ref' }, 'connector_invalid_request', 'invalid_ref'],
    [{ status: 409, error: 'not_installed' }, 'connector_refused', 'not_installed'],
    [
      { status: 401, error: 'signed_out' },
      'connector_not_connected',
      "isn't signed in to Orca Cloud: sign in to Orca Cloud on this computer"
    ]
  ])('names the cloud refusal %j', async (failure, code, says) => {
    const { context } = actContext({
      features: ['actions'],
      answers: [{ ok: false, retryAfterMs: null, ...failure }]
    })
    await expect(
      run({ sessionId: 'bot-session', verb: 'read', ref: 'slack:T1:C1' }, context)
    ).rejects.toMatchObject({ code, message: expect.stringContaining(says) })
  })

  it('enables single-message reads in CLI output only after the cloud advertises message parts', async () => {
    const { context } = actContext({
      features: ['actions', 'messageParts'],
      answers: [{ ok: true, value: { ok: true, result: { messages: [] } } }]
    })
    await expect(
      run({ sessionId: 'bot-session', verb: 'read', ref: 'slack:T1:C1' }, context)
    ).resolves.toEqual({ ok: true, result: { messages: [], messageParts: true } })
  })

  it('ignores a result marker when single-message reads were not negotiated', async () => {
    const { context } = actContext({
      features: ['actions'],
      answers: [{ ok: true, value: { ok: true, result: { messages: [], messageParts: true } } }]
    })
    await expect(
      run({ sessionId: 'bot-session', verb: 'read', ref: 'slack:T1:C1' }, context)
    ).resolves.toEqual({ ok: true, result: { messages: [] } })
  })

  it('retries a read the cloud did not answer', async () => {
    const answer = { ok: true, result: { messages: [] } }
    const { context, calls } = actContext({
      features: ['actions'],
      answers: [
        { ok: false, status: 503, error: null, retryAfterMs: 1 },
        { ok: true, value: answer }
      ]
    })
    await expect(
      run({ sessionId: 'bot-session', verb: 'read', ref: 'slack:T1:C1' }, context)
    ).resolves.toEqual(answer)
    expect(calls).toHaveLength(2)
  })

  it('reaches the CLI with its code and its words', () => {
    const response = mapRuntimeError(
      'r1',
      { runtimeId: 'rt' },
      new ConnectorActError('bot_not_in_cloud', "This bot isn't on Orca Cloud.")
    )
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'bot_not_in_cloud', message: "This bot isn't on Orca Cloud." }
    })
  })

  describe('Slack words never carry a path on this machine', () => {
    const OK = { ok: true, value: { ok: true, result: {} } }
    const sent = async (
      input: Record<string, unknown>,
      conversation?: { source: string; externalId: string }
    ) => {
      const { context, calls } = actContext({
        features: ['actions', 'slack.tools', 'reply.files', 'files.direct', 'create'],
        answers: [OK],
        ...(conversation ? { conversation } : {})
      })
      await run({ sessionId: 'bot-session', ...input }, context)
      const body: unknown = calls[0]?.body
      return typeof body === 'object' && body !== null && 'args' in body ? body.args : undefined
    }

    it('scrubs a post, an edit, a canvas and a list in Slack', async () => {
      await expect(
        sent({
          verb: 'post',
          ref: 'slack:T1:C1',
          args: {
            text: 'Report: ![side by side](~/.orca/reports/r/side.png) at /Users/ada/r/report.html'
          }
        })
      ).resolves.toEqual({ text: 'Report: side by side at report.html' })
      await expect(
        sent({ verb: 'edit', ref: 'slack:T1:C1:1.2', args: { text: 'See /tmp/run/out.log' } })
      ).resolves.toEqual({ text: 'See out.log' })
      await expect(
        sent({
          verb: 'canvas',
          ref: '#eng',
          args: { title: 'Notes /Users/ada/n.md', text: '[plan](/Users/ada/plan.md)' }
        })
      ).resolves.toEqual({ title: 'Notes n.md', text: 'plan' })
      await expect(
        sent({
          verb: 'list',
          ref: '#eng',
          args: { title: 'Todo', items: ['open ~/a/b.pdf', 'ship'] }
        })
      ).resolves.toEqual({ title: 'Todo', items: ['open b.pdf', 'ship'] })
    })

    it("keeps an explicit file's staging and only scrubs the caption", async () => {
      await expect(
        sent(
          {
            verb: 'reply',
            args: { files: ['p1'], postId: 'p2', text: 'Here is /Users/ada/r/report.html' }
          },
          { source: 'slack', externalId: 'T1:C1:1.2:U0BOT' }
        )
      ).resolves.toEqual({ files: ['p1'], postId: 'p2', text: 'Here is report.html' })
    })

    it('scrubs a post to a person or a pasted Slack link', async () => {
      for (const ref of ['@dana', 'https://acme.slack.com/archives/C0123ABCD/p1700000000000100']) {
        await expect(
          sent({ verb: 'post', ref, args: { text: 'At /tmp/r/a.md' } })
        ).resolves.toEqual({ text: 'At a.md' })
      }
    })

    it('leaves GitHub, Linear and names only Orca Cloud resolves as they are', async () => {
      const text = 'See /Users/ada/r/report.html'
      await expect(
        sent({ verb: 'post', ref: 'ENG', args: { title: 'Bug', text } })
      ).resolves.toEqual({ title: 'Bug', text })
      await expect(sent({ verb: 'post', ref: 'deploys', args: { text } })).resolves.toEqual({
        text
      })
      await expect(
        sent({ verb: 'reply', args: { text } }, { source: 'github', externalId: 'o/r#1' })
      ).resolves.toEqual({ text })
      await expect(
        sent({ verb: 'post', ref: 'linear:acme:team:ENG', args: { title: 'Bug', text } })
      ).resolves.toEqual({ title: 'Bug', text })
    })
  })
})
