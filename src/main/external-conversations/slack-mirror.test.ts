import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { fakeLinkStore, WORKTREE } from './external-conversation.test-fixture'
import { readLinks } from './external-conversation-links'
import { writeChatLink } from './external-conversation-link-writes'
import { ConnectorAsker } from '../../shared/connector-asker-contract'
import { SlackMirror } from './slack-mirror'
import type { SlackMirrorCloud } from './slack-mirror-cloud'
import type { ConversationTurnEnd } from './slack-mirror-held'

const SESSION = 'session-1'
const ITEM = agentJournalSubmissionKey('send-1')
const SENT_2 = agentJournalSubmissionKey('send-2')
const workspace = { worktreeId: WORKTREE, sshHostId: null }

function link(fields: Partial<ExternalConversationLink> = {}): ExternalConversationLink {
  return {
    source: 'slack',
    externalId: 'T1:C9:1792.9:U5',
    sessionId: SESSION,
    agent: 'claude',
    paneKey: `chat:${SESSION}`,
    bot: { kind: 'bot', botId: 'bot-1' },
    mirror: true,
    mirrorChosen: true,
    createdAt: 1,
    ...fields
  }
}

const typed: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Sam, updating staging now.' }]
}

type Answer = { ok: true; value: unknown } | { ok: false; status: number; error: string }

const ended: ConversationTurnEnd = {
  kind: 'turn-ended',
  conversation: { source: 'slack', externalId: 'T1:C9:1792.9:U5' },
  worktreeId: WORKTREE,
  paneKey: `chat:${SESSION}`,
  turnId: 3,
  stopReason: 'success',
  at: 9,
  origin: 'local',
  mirror: true,
  lastAssistantMessage: 'Prod is fine.'
}

function setUp(answers: (Answer | Promise<Answer>)[], linked = link()) {
  const fixture = fakeLinkStore()
  fixture.put(WORKTREE, 'local', { externalConversations: [linked] })
  const calls: { path: string; body: unknown }[] = []
  const told: ConversationTurnEnd[] = []
  // What each item of the chat says now; any other reads as `typed`.
  const messages = new Map<string, AgentJournalMessageItem>()
  let watching = true
  const cloud: SlackMirrorCloud = {
    cloudFeatures: () => new Set(['slack.mirror']),
    call: async (path, body, schema) => {
      calls.push({ path, body })
      // The post answers with its ts; every other mirror route answers with no body.
      const answer = (await answers.shift()) ?? {
        ok: true,
        value: path.endsWith('/mirror') ? { ts: '1.2' } : undefined
      }
      return answer.ok
        ? { ok: true, value: schema.parse(answer.value) }
        : { ...answer, retryAfterMs: null }
    }
  }
  const make = () =>
    new SlackMirror({
      store: fixture.store,
      cloud: () => cloud,
      orcaName: () => 'Alice',
      botSetting: () => undefined,
      readMessage: async (_sessionId, itemId) => messages.get(itemId) ?? typed,
      emitTurnEnd: (event) => watching && told.push(event) > 0,
      signal: new AbortController().signal
    })
  const mirror = make()
  const current = () => readLinks(fixture.store, workspace)[0]
  const post = () => current()?.mirrorPosts?.[ITEM]
  const admit = (body = typed, on = mirror) =>
    on.admitted({
      sessionId: SESSION,
      workspaceId: WORKTREE,
      clientMessageId: 'send-1',
      body,
      joinsRunningTurn: false
    })
  const watch = (on: boolean) => {
    watching = on
  }
  /** The same message handed over again as `send`, first admitted as send-1. */
  const handOver = (send: string, on = mirror, first = 'send-1') =>
    on.admitted({
      sessionId: SESSION,
      workspaceId: WORKTREE,
      clientMessageId: send,
      body: messages.get(agentJournalSubmissionKey(send)) ?? typed,
      joinsRunningTurn: false,
      firstAdmittedAs: first
    })
  const routes = () =>
    calls.map(({ path, body }) => [
      path.split('/mirror')[1]?.slice(1) || 'post',
      (body as { clientMessageId: string }).clientMessageId
    ])
  return {
    fixture,
    mirror,
    make,
    calls,
    told,
    current,
    post,
    admit,
    watch,
    messages,
    handOver,
    routes
  }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('SlackMirror', () => {
  it("posts the owner's typed message and tells the turn's reply once it is in the thread", async () => {
    const { mirror, calls, told, post, admit } = setUp([{ ok: true, value: { ts: '1.2' } }])
    admit()
    mirror.turnEnded(SESSION)?.release(ended)
    expect(told).toEqual([])
    await flush()
    expect(calls).toEqual([
      {
        path: '/v1/connector/bots/bot-1/mirror',
        body: {
          v: 1,
          clientMessageId: 'send-1',
          conversation: { source: 'slack', externalId: 'T1:C9:1792.9:U5' },
          text: 'Sam, updating staging now.',
          author: { orcaName: 'Alice', typist: { kind: 'host' } }
        }
      }
    ])
    expect(post()?.state).toBe('posted')
    expect(told).toEqual([ended])
  })

  it('keeps one post for a message handed over again, shown on the item the chat shows now', async () => {
    const { mirror, told, admit, handOver, routes, current } = setUp([])
    admit()
    await flush()
    mirror.turnEnded(SESSION)
    handOver('send-2')
    await flush()
    expect(routes()).toEqual([['post', 'send-1']])
    // Every client reads a post by the item it shows, and an older one only its state.
    expect(current()?.mirrorPosts).toEqual({
      [SENT_2]: {
        state: 'posted',
        at: expect.any(Number),
        clientMessageId: 'send-1',
        firstAdmittedAs: 'send-1'
      }
    })
    expect(mirror.turnPosted(SESSION)).toBe(true)
    mirror.turnEnded(SESSION)?.release(ended)
    expect(told).toEqual([ended])
  })

  it('edits the post in place when only the words changed, and the reply waits for the edit', async () => {
    const { mirror, told, admit, handOver, routes, calls, messages, current } = setUp([])
    admit()
    await flush()
    mirror.turnEnded(SESSION)
    messages.set(SENT_2, { ...typed, blocks: [{ type: 'text', text: 'Sam, staging is next.' }] })
    handOver('send-2')
    mirror.turnEnded(SESSION)?.release(ended)
    expect(told).toEqual([])
    await flush()
    expect(routes()).toEqual([
      ['post', 'send-1'],
      ['update', 'send-1']
    ])
    expect(calls[1]!.body).toMatchObject({ text: 'Sam, staging is next.' })
    expect(current()?.mirrorPosts?.[SENT_2]).toMatchObject({ state: 'posted', edited: true })
    expect(told).toEqual([ended])
  })

  it('posts afresh under the shown send when the files or who typed it changed', async () => {
    const { mirror, admit, handOver, routes, messages, current } = setUp([])
    admit()
    await flush()
    mirror.turnEnded(SESSION)
    messages.set(SENT_2, { ...typed, typedBy: { by: 'device', deviceId: 'phone', account: 'Sam' } })
    handOver('send-2')
    await flush()
    expect(routes()).toEqual([
      ['post', 'send-1'],
      ['delete', 'send-1'],
      ['post', 'send-2']
    ])
    expect(current()?.mirrorPosts).toEqual({
      [SENT_2]: { state: 'posted', at: expect.any(Number), firstAdmittedAs: 'send-1' }
    })
  })

  it('a quit between the delete and the fresh post leaves Retry, which posts it once', async () => {
    const { mirror, make, admit, handOver, routes, messages, post, current } = setUp([
      { ok: true, value: { ts: '1.2' } },
      { ok: true, value: undefined },
      new Promise<Answer>(() => {})
    ])
    admit()
    await flush()
    mirror.turnEnded(SESSION)
    messages.set(SENT_2, { ...typed, typedBy: { by: 'device', deviceId: 'phone', account: 'Sam' } })
    handOver('send-2')
    await flush()
    const restarted = make()
    expect(await restarted.retry(SESSION, SENT_2)).toBe(true)
    expect(routes()).toEqual([
      ['post', 'send-1'],
      ['delete', 'send-1'],
      ['post', 'send-2'],
      ['post', 'send-2']
    ])
    expect(post()).toBeUndefined()
    expect(current()?.mirrorPosts?.[SENT_2]?.state).toBe('posted')
  })

  it('finishes a moved post that failed on Retry under the send it went as, then edits it', async () => {
    const { mirror, admit, handOver, routes, messages, current } = setUp([
      { ok: false, status: 409, error: 'transient' }
    ])
    admit()
    await flush()
    mirror.turnEnded(SESSION)
    messages.set(SENT_2, { ...typed, blocks: [{ type: 'text', text: 'Sam, staging is next.' }] })
    handOver('send-2')
    await flush()
    expect(current()?.mirrorPosts?.[SENT_2]?.state).toBe('failed')
    expect(await mirror.retry(SESSION, SENT_2)).toBe(true)
    expect(routes()).toEqual([
      ['post', 'send-1'],
      ['post', 'send-1'],
      ['update', 'send-1']
    ])
    expect(current()?.mirrorPosts?.[SENT_2]?.state).toBe('posted')
  })

  it('an edit that fails keeps Retry, which edits it again', async () => {
    const { mirror, admit, handOver, routes, messages, current } = setUp([
      { ok: true, value: { ts: '1.2' } },
      { ok: false, status: 409, error: 'transient' }
    ])
    admit()
    await flush()
    mirror.turnEnded(SESSION)
    messages.set(SENT_2, { ...typed, blocks: [{ type: 'text', text: 'Sam, staging is next.' }] })
    handOver('send-2')
    await flush()
    expect(current()?.mirrorPosts?.[SENT_2]?.state).toBe('failed')
    expect(await mirror.retry(SESSION, SENT_2)).toBe(true)
    expect(routes()).toEqual([
      ['post', 'send-1'],
      ['update', 'send-1'],
      ['post', 'send-1'],
      ['update', 'send-1']
    ])
    expect(current()?.mirrorPosts?.[SENT_2]?.state).toBe('posted')
  })

  it('a post still going when the message is handed over settles on the shown item, posted once', async () => {
    const { mirror, admit, handOver, routes, current } = setUp([])
    admit()
    handOver('send-2')
    expect(current()?.mirrorPosts?.[SENT_2]?.state).toBe('posting')
    await flush()
    expect(routes()).toEqual([['post', 'send-1']])
    expect(Object.keys(current()?.mirrorPosts ?? {})).toEqual([SENT_2])
    expect(current()?.mirrorPosts?.[SENT_2]?.state).toBe('posted')
    expect(mirror.turnPosted(SESSION)).toBe(true)
  })

  it('never posts a handed-over message whose post was deleted, dismissed or never made', async () => {
    const moved = {
      state: 'posted' as const,
      at: 1,
      clientMessageId: 'send-1',
      firstAdmittedAs: 'send-1'
    }
    const { mirror, handOver, routes, post, current } = setUp(
      [{ ok: true, value: undefined }],
      link({ mirrorPosts: { [SENT_2]: moved } })
    )
    expect(await mirror.deleteFromSlack(SESSION, SENT_2)).toBe(true)
    expect(routes()).toEqual([['delete', 'send-1']])
    handOver('send-3')
    await flush()
    expect(routes()).toEqual([['delete', 'send-1']])
    expect(current()?.mirrorPosts).toEqual({})
    expect(post()).toBeUndefined()
    expect(mirror.turnEnded(SESSION)).toBeNull()
  })

  it('an edit Slack answers as deleted leaves the post deleted', async () => {
    const { mirror, admit, handOver, messages, current } = setUp([
      { ok: true, value: { ts: '1.2' } },
      { ok: false, status: 409, error: 'deleted' }
    ])
    admit()
    await flush()
    mirror.turnEnded(SESSION)
    messages.set(SENT_2, { ...typed, blocks: [{ type: 'text', text: 'Sam, staging is next.' }] })
    handOver('send-2')
    await flush()
    expect(current()?.mirrorPosts).toEqual({})
  })

  it('names who typed each message as the host saw it', async () => {
    const cases: [AgentJournalMessageItem['typedBy'], unknown][] = [
      [{ by: 'host' }, { orcaName: 'Alice', typist: { kind: 'host' } }],
      // From before the stamp was kept: the host's, as the cloud reads it.
      [undefined, { orcaName: 'Alice', typist: { kind: 'host' } }],
      // The account the device claimed when it sent, by name only.
      [
        { by: 'device', deviceId: 'laptop-sam', account: 'Sam Lee' },
        { orcaName: 'Alice', typist: { kind: 'account', name: 'Sam Lee' } }
      ],
      [
        { by: 'device', deviceId: 'phone-qr' },
        { orcaName: 'Alice', typist: { kind: 'computer' } }
      ],
      [{ by: 'agent' }, { orcaName: 'Alice', agent: true }]
    ]
    for (const [typedBy, author] of cases) {
      const { calls, admit } = setUp([])
      admit({ ...typed, typedBy })
      await flush()
      expect(calls[0]?.body).toMatchObject({ author })
    }
  })

  it('holds the reply while the post failed, and Dismiss lets it go alone', async () => {
    const { mirror, told, post, admit, current } = setUp([
      { ok: false, status: 409, error: 'missing_scope' }
    ])
    admit()
    mirror.turnEnded(SESSION)?.release(ended)
    await flush()
    expect(post()).toMatchObject({ state: 'failed', error: 'missing_scope' })
    expect(told).toEqual([])
    expect(mirror.dismiss(SESSION, ITEM)).toBe(true)
    expect(told).toEqual([ended])
    expect(post()).toBeUndefined()
    expect(current()?.mirrorHeld).toBeUndefined()
  })

  it("counts the running turn as the thread's only while its post is posting or posted", async () => {
    const { mirror, admit } = setUp([
      { ok: false, status: 409, error: 'transient' },
      { ok: true, value: { ts: '1.3' } }
    ])
    expect(mirror.turnPosted(SESSION)).toBe(false)
    admit()
    expect(mirror.turnPosted(SESSION)).toBe(true)
    await flush()
    // The thread never saw it: the turn's workers stay in Orca.
    expect(mirror.turnPosted(SESSION)).toBe(false)
    await mirror.retry(SESSION, ITEM)
    expect(mirror.turnPosted(SESSION)).toBe(true)
  })

  it('Retry posts the message again and then tells the reply', async () => {
    const { mirror, told, post, admit } = setUp([
      { ok: false, status: 409, error: 'transient' },
      { ok: true, value: { ts: '1.3' } }
    ])
    admit()
    mirror.turnEnded(SESSION)?.release(ended)
    await flush()
    expect(post()?.state).toBe('failed')
    expect(await mirror.retry(SESSION, ITEM)).toBe(true)
    expect(post()?.state).toBe('posted')
    expect(told).toEqual([ended])
  })

  it('a post still going at quit reads failed (interrupted) after a restart', () => {
    const { make, post } = setUp([], link({ mirrorPosts: { [ITEM]: { state: 'posting', at: 1 } } }))
    make()
    expect(post()).toMatchObject({ state: 'failed', error: 'interrupted' })
  })

  it('a reply ready while no connector watches waits on the link until one does', async () => {
    const { mirror, told, admit, watch, current } = setUp([])
    watch(false)
    admit()
    mirror.turnEnded(SESSION)?.release(ended)
    await flush()
    expect(current()?.mirrorHeld).toHaveLength(1)
    watch(true)
    mirror.flushHeld()
    expect(told).toEqual([ended])
    expect(current()?.mirrorHeld).toBeUndefined()
  })

  it('a deleted thread blocks the chat; a clean status read opens it again', async () => {
    const { mirror, admit, current } = setUp([
      { ok: false, status: 409, error: 'thread_not_found' },
      { ok: true, value: { customize: true } }
    ])
    admit()
    await flush()
    expect(current()?.mirrorBlocked).toBe('thread_unavailable')
    expect(mirror.setMirror(SESSION, true)).toBe(false)
    await mirror.status(SESSION)
    expect(current()?.mirrorBlocked).toBeUndefined()
  })

  it('a delivery from the thread clears a not-in-channel block (the bot was invited back)', () => {
    const { admit, current } = setUp([], link({ mirrorBlocked: 'not_in_channel' }))
    admit({ ...typed, origin: 'connector' })
    expect(current()?.mirrorBlocked).toBeUndefined()
  })

  it('once the bot is back in the channel, Retry posts the failed message', async () => {
    const { mirror, admit, current, post } = setUp([
      { ok: false, status: 409, error: 'not_in_channel' },
      { ok: true, value: { customize: true } },
      { ok: true, value: { ts: '1.4' } }
    ])
    admit()
    await flush()
    expect(current()?.mirrorBlocked).toBe('not_in_channel')
    expect(await mirror.retry(SESSION, ITEM)).toBe(false)
    await mirror.status(SESSION)
    expect(await mirror.retry(SESSION, ITEM)).toBe(true)
    expect(post()?.state).toBe('posted')
  })

  it('keeps a Slack Connect thread in Orca unless the owner turned it on', async () => {
    const auto = setUp(
      [{ ok: true, value: { external: true, customize: true } }],
      link({ mirrorChosen: undefined })
    )
    auto.admit()
    await flush()
    expect(auto.calls.map((call) => call.path)).toEqual([
      '/v1/connector/bots/bot-1/mirror/status?conversation=T1%3AC9%3A1792.9%3AU5'
    ])
    expect(auto.post()).toBeUndefined()
    expect(auto.current()?.mirrorExternal).toBe(true)
    const inWorkspace = setUp(
      [{ ok: true, value: { customize: true } }],
      link({ mirrorChosen: undefined })
    )
    inWorkspace.admit()
    await flush()
    expect(inWorkspace.post()?.state).toBe('posted')
    const chosen = setUp([], link({ mirrorChosen: true, mirrorExternal: true }))
    chosen.admit()
    await flush()
    expect(chosen.post()?.state).toBe('posted')
  })

  it("never posts from the bot's own Chat", async () => {
    const { calls, admit, mirror } = setUp([], link({ bot: { kind: 'bot-chat', botId: 'bot-1' } }))
    admit()
    await flush()
    expect(calls).toEqual([])
    expect(mirror.setMirror(SESSION, true)).toBe(false)
  })

  it('a rebound older link keeps its opener; only a new thread chat takes the speaker', () => {
    const asker = ConnectorAsker.parse({
      userId: 'U9',
      role: 'member',
      place: { kind: 'public_channel', id: 'C9' },
      text: 'hi',
      context: []
    })
    const older = setUp([], link({ mirror: undefined }))
    const linked = { workspace, link: older.current()! }
    expect(older.mirror.opened(linked, asker, false)).toBe(linked)
    expect(older.current()?.opener).toBeUndefined()
    const fresh = setUp([], link({ mirror: undefined }))
    fresh.mirror.opened({ workspace, link: fresh.current()! }, asker, true)
    expect(fresh.current()).toMatchObject({ opener: { role: 'member' }, mirror: false })
  })

  it('a default-on chat whose thread status could not be read never posts; Retry reads it again', async () => {
    const { mirror, calls, admit, post, current } = setUp(
      [
        { ok: false, status: 503, error: 'transient' },
        { ok: true, value: { customize: true } },
        { ok: true, value: { ts: '1.5' } }
      ],
      link({ mirrorChosen: undefined })
    )
    admit()
    await flush()
    expect(calls.every((call) => call.path.includes('/mirror/status'))).toBe(true)
    expect(post()).toMatchObject({ state: 'failed', error: 'status_unknown' })
    expect(current()?.mirrorExternal).toBeUndefined()
    expect(await mirror.retry(SESSION, ITEM)).toBe(true)
    expect(post()?.state).toBe('posted')
  })

  it("fails an empty message without calling Slack, and keeps the cloud's refusal of a long one", async () => {
    const empty = setUp([])
    empty.admit({ ...typed, blocks: [] })
    await flush()
    expect(empty.post()).toMatchObject({ state: 'failed', error: 'empty' })
    expect(empty.calls).toEqual([])
    const long = setUp([{ ok: false, status: 400, error: 'invalid_request' }])
    long.admit({ ...typed, blocks: [{ type: 'text', text: 'x'.repeat(40_001) }] })
    await flush()
    expect(long.calls).toHaveLength(1)
    expect(long.post()).toMatchObject({ state: 'failed', error: 'invalid_request' })
  })

  it('a rebind carries the failed post with its held reply, so Dismiss in the new chat lets it go', async () => {
    const { fixture, make, told, admit, mirror } = setUp([
      { ok: false, status: 409, error: 'transient' }
    ])
    admit()
    mirror.turnEnded(SESSION)?.release(ended)
    await flush()
    writeChatLink(
      fixture.store,
      { source: 'slack', externalId: 'T1:C9:1792.9:U5' },
      {
        worktreeId: WORKTREE,
        sessionId: 'session-2',
        agent: 'claude',
        bot: { kind: 'bot', botId: 'bot-1' }
      }
    )
    expect(make().dismiss('session-2', ITEM)).toBe(true)
    expect(told).toEqual([ended])
  })

  it('Delete from Slack takes a posted message back and drops its badge', async () => {
    const { mirror, calls, post } = setUp(
      [{ ok: true, value: undefined }],
      link({ mirrorPosts: { [ITEM]: { state: 'posted', at: 1 } } })
    )
    expect(await mirror.deleteFromSlack(SESSION, ITEM)).toBe(true)
    expect(calls).toEqual([
      {
        path: '/v1/connector/bots/bot-1/mirror/delete',
        body: {
          v: 1,
          clientMessageId: 'send-1',
          conversation: { source: 'slack', externalId: 'T1:C9:1792.9:U5' }
        }
      }
    ])
    expect(post()).toBeUndefined()
  })

  it('never posts mail, deliveries or a chat that is off', async () => {
    const mail = setUp([])
    mail.admit({
      ...typed,
      from: { kind: 'agent', senders: [], orchestration: null }
    })
    mail.admit({ ...typed, origin: 'connector' })
    expect(mail.calls).toEqual([])
    expect(mail.post()).toBeUndefined()
    expect(mail.mirror.turnEnded(SESSION)).toBeNull()
    const off = setUp([], link({ mirror: false }))
    off.admit()
    expect(off.calls).toEqual([])
    expect(off.post()).toBeUndefined()
    expect(off.mirror.turnEnded(SESSION)).toBeNull()
  })
})
