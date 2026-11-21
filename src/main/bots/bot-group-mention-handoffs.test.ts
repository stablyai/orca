import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { BotGroupMessage } from '../../shared/bots/bot-group'
import { fixture, groupNativeMocks, journal } from './bot-group-native-runtime.test-fixture'
import { noteBotGroupMemberReply } from './bot-group-latest'
import { BOT_ITEM_MAIL_SENDER } from '../../shared/bots/bot-item-note-runs'

const live = vi.hoisted((): { turnItemId: string | null } => ({ turnItemId: null }))
vi.mock('../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    currentWork: async () => ({
      activeTurn: () => (live.turnItemId ? { item: { itemId: live.turnItemId } } : null)
    }),
    journalReads: async (sessionId: string) => ({
      operationWindow: async () => ({ snapshot: await groupNativeMocks().snapshot(sessionId) })
    })
  })
}))

const mocks = groupNativeMocks()

/** The prompt delivered for a group operation, once it was sent. */
async function sentPrompt(operationId: string): Promise<string> {
  const sent = () => mocks.send.mock.calls.find((call) => call[0].turn.operationId === operationId)
  await vi.waitFor(() => expect(sent()).toBeDefined())
  return sent()![0].turn.body.blocks[0].text
}

/** A room of Scout and Forge whose members' chats answer with the replies `reply` records. */
async function room() {
  const { groups, runtime, startWorker, orchestration, mails } = fixture()
  const created = await groups.create({ name: 'Review', botIds: ['bot-0', 'bot-1'] })
  groups.store.put({ ...created, replyMode: { kind: 'mentions' } })
  const replies = new Map<string, { operationId: string; text: string; at: number }[]>()
  mocks.snapshot.mockImplementation(async (sessionId) =>
    journal(sessionId, replies.get(sessionId) ?? [])
  )
  let at = 1
  const post = (text: string) =>
    groups.send({
      groupId: created.id,
      revision: groups.store.get(created.id).revision,
      messageId: randomUUID(),
      text
    })
  /** The turn's member finishes it with `text` in its chat. */
  const finish = async (message: BotGroupMessage, text: string) => {
    await vi.waitFor(() => expect(groups.store.pending()).toEqual([]))
    const turn = message.turns[0]!
    replies.set(turn.sessionId, [
      ...(replies.get(turn.sessionId) ?? []),
      { operationId: turn.operationId, text, at: at++ }
    ])
  }
  /** The chat reports the message's turn ended. */
  const ended = (message: BotGroupMessage) => {
    const turn = message.turns[0]!
    return noteBotGroupMemberReply(runtime, turn.sessionId, `t-${turn.operationId}`)
  }
  const reply = async (message: BotGroupMessage, text: string) => {
    await finish(message, text)
    await ended(message)
  }
  const lines = () => groups.store.messages(created.id, 100)
  const newest = () => lines().at(-1)!
  return {
    groups,
    runtime,
    startWorker,
    orchestration,
    mails,
    group: created,
    post,
    finish,
    ended,
    reply,
    lines,
    newest
  }
}

/** The mail lane's notice to a member for one mail. */
function mailNotice(sessionId: string, operationId: string, messageId: string, from: string) {
  return {
    sessionId,
    dispatchId: null,
    operationId,
    expectedRuntimeFence: 1,
    stillOwed: () => true,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [],
      from: {
        kind: 'agent' as const,
        senders: [],
        orchestration: {
          message: 'mail-notice' as const,
          mailbox: sessionId,
          dispatchId: null,
          messages: [{ messageId, runId: 'run', from }]
        }
      }
    }
  }
}

describe('group @Name hand-offs', () => {
  it("wakes a member a reply names under the same person's post, never the speaker", async () => {
    const { runtime, post, reply, lines, newest } = await room()
    const asked = await post('@Scout plan the release')
    await reply(asked, 'Plan ready. @Scout notes for me; @forge please review.')
    const handoff = newest()
    expect(handoff).toMatchObject({
      author: { kind: 'bot', id: 'bot-0', name: 'Scout' },
      requester: { id: 'bot-0', name: 'Scout' },
      mentioned: true,
      rootRequestId: asked.id,
      rootSequence: asked.sequence
    })
    expect(handoff.turns.map((turn) => turn.botId)).toEqual(['bot-1'])
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2))
    const prompt: string = mocks.send.mock.calls[1]![0].turn.body.blocks[0].text
    expect(prompt).toContain(`Original human instruction (room message ${asked.id}`)
    expect(prompt).toContain('@Scout plan the release')
    expect(prompt).toContain('Plan ready.')
    // The same turn end reported again wakes no one twice.
    await noteBotGroupMemberReply(
      runtime,
      asked.turns[0]!.sessionId,
      `t-${asked.turns[0]!.operationId}`
    )
    expect(lines()).toHaveLength(2)
  })

  it('quotes the naming reply to a member whose history was taken after a later post', async () => {
    const { post, reply, newest } = await room()
    const asked = await post('@Scout plan')
    await post('@Forge something else')
    await reply(asked, 'Plan X is ready. @Forge review it.')
    expect(await sentPrompt(newest().turns[0]!.operationId)).toContain('Plan X is ready.')
  })

  it('ignores names in code and keeps a long chain going without a pause', async () => {
    const { post, reply, lines, newest } = await room()
    await reply(await post('@Scout start'), 'Run `@Forge` first.')
    expect(lines()).toHaveLength(1)
    const asked = await post('@Scout go')
    await reply(asked, '@Forge your turn')
    for (let hop = 0; hop < 9; hop++) {
      await reply(newest(), hop % 2 === 0 ? '@Scout yours' : '@Forge yours')
    }
    const after = lines().slice(2)
    expect(after).toHaveLength(10)
    expect(after.every((line) => line.mentioned && line.rootRequestId === asked.id)).toBe(true)
    expect(after.some((line) => line.pausedAfter !== undefined)).toBe(false)
  })

  it("follows a peer reply's mention, and a stopped room wakes no one", async () => {
    const { groups, group, post, reply, lines, newest } = await room()
    const asked = await post('@Scout look')
    await groups.stop(group.id)
    await reply(asked, '@Forge check this')
    expect(lines()).toHaveLength(1)

    const next = await post('@Scout again')
    const [scout] = groups.store.get(group.id).members
    const mailLine = (id: string) =>
      groups.store.append({
        id,
        groupId: group.id,
        author: { kind: 'bot', id: 'bot-0', name: 'Scout' },
        text: 'Forge asked Scout',
        createdAt: next.createdAt,
        rootRequestId: next.id,
        rootSequence: next.sequence,
        requester: { id: 'bot-1', name: 'Forge' },
        turns: [
          { ...next.turns[0]!, operationId: `${id}-op`, sessionId: scout!.sessionId, mailbox: true }
        ]
      })
    await reply(mailLine('mail-line'), '@Forge answered')
    expect(newest()).toMatchObject({
      mentioned: true,
      requester: { id: 'bot-0' },
      rootRequestId: next.id
    })
    expect(newest().turns.map((turn) => turn.botId)).toEqual(['bot-1'])

    await groups.stop(group.id)
    const count = lines().length
    await reply(mailLine('late-mail'), '@Forge one more')
    expect(lines()).toHaveLength(count + 1)
    expect(newest().id).toBe('late-mail')
  })

  it('wakes no second turn for a member the same turn already mailed', async () => {
    const { groups, group, post, reply, lines } = await room()
    const next = await post('@Scout look')
    const [scout] = groups.store.get(group.id).members
    const mailLine = (id: string) =>
      groups.store.append({
        id,
        groupId: group.id,
        author: { kind: 'bot', id: 'bot-0', name: 'Scout' },
        text: 'Forge asked Scout',
        createdAt: next.createdAt,
        rootRequestId: next.id,
        rootSequence: next.sequence,
        requester: { id: 'bot-1', name: 'Forge' },
        turns: [
          { ...next.turns[0]!, operationId: `${id}-op`, sessionId: scout!.sessionId, mailbox: true }
        ]
      })
    // Scout answers Forge's request by reply, then names Forge too.
    const answered = mailLine('answered')
    groups.saveAnswer('answered-op', 'Use the staging bucket.')
    await reply(answered, '@Forge answered above')
    // Scout sends Forge a peer request, then names Forge too.
    const sent = mailLine('sent')
    groups.noteMailed('sent-op', 'bot-1')
    await reply(sent, 'Asked @Forge for the logs')
    expect(lines().map((line) => line.id)).toEqual([next.id, 'answered', 'sent'])
  })

  it('wakes no second turn for a member a mail turn sent a request to and named', async () => {
    const { groups, group, post, reply, finish, ended, lines } = await room()
    const next = await post('@Scout look')
    await reply(next, 'On it.')
    const [scout] = groups.store.get(group.id).members
    const mail = groups.store.append({
      id: 'mail',
      groupId: group.id,
      author: { kind: 'bot', id: 'bot-0', name: 'Scout' },
      text: 'Scout read a reply',
      createdAt: next.createdAt,
      rootRequestId: next.id,
      rootSequence: next.sequence,
      requester: { id: 'bot-0', name: 'Scout' },
      turns: [
        { ...next.turns[0]!, operationId: 'mail-op', sessionId: scout!.sessionId, mailbox: true }
      ]
    })
    await finish(mail, 'Asked @Forge for the logs')
    // A mail turn has no send of its own: its root row is the earlier turn's send.
    live.turnItemId = 'turn-mail-op'
    const scope = await groups.peerScope(
      scout!.sessionId,
      'bot-1',
      agentJournalSubmissionKey(next.turns[0]!.operationId)
    )
    groups.noteMailed(scope?.operationId, 'bot-1')
    live.turnItemId = null
    await ended(mail)
    expect(lines().map((line) => line.id)).toEqual([next.id, 'mail'])
  })

  it("wakes the member a worker report's turn names", async () => {
    const { groups, post, reply, newest, startWorker, orchestration } = await room()
    const asked = await post('@Scout build it')
    const scout = asked.turns[0]!
    const worker = startWorker('term_worker')
    groups.store.bindWorker(worker.dispatchId, scout.operationId)
    await reply(asked, 'Started a worker.')
    const done = worker.send(scout.sessionId, 'worker_done')
    orchestration.completeDispatch(worker.dispatchId)
    groups.reserveMailTurn(mailNotice(scout.sessionId, 'report-op', done.id, 'term_worker'))
    const report = newest()
    expect(report.turns[0]).toMatchObject({ operationId: 'report-op', mailbox: true })
    await reply(report, 'Build done. @Forge please test')
    expect(newest()).toMatchObject({ mentioned: true, rootRequestId: asked.id })
    expect(newest().turns.map((turn) => turn.botId)).toEqual(['bot-1'])
  })

  it("starts the member's turn on an item change made outside the room, and follows its mention", async () => {
    const { groups, group, mails, post, reply, newest } = await room()
    const [scout] = groups.store.get(group.id).members
    const asked = await post('@Scout plan')
    await reply(asked, 'Asked my owner on item #1.')
    await groups.stop(group.id)
    const answer = {
      id: 'item-mail-1',
      thread_id: null,
      from_handle: BOT_ITEM_MAIL_SENDER,
      type: 'status',
      subject: 'Your owner answered (#1 Pick a database)'
    }
    mails.set(answer.id, answer)
    expect(groups.narrowMailBatch(scout!.sessionId, [answer])).toEqual({
      messages: [answer],
      ended: []
    })
    groups.reserveMailTurn(mailNotice(scout!.sessionId, 'item-op', answer.id, BOT_ITEM_MAIL_SENDER))
    const line = newest()
    expect(line).toMatchObject({ fromItems: true, author: { kind: 'bot', id: 'bot-0' } })
    expect(line.turns[0]).toMatchObject({ operationId: 'item-op', mailbox: true })
    await reply(line, 'Going with Postgres. @Forge set it up')
    expect(newest()).toMatchObject({ mentioned: true, rootRequestId: line.id })
    expect(newest().turns.map((turn) => turn.botId)).toEqual(['bot-1'])
    // The item's text reaches Forge as quoted data, never as the owner's instruction.
    const prompt = await sentPrompt(newest().turns[0]!.operationId)
    expect(prompt).toContain('An update to items made outside the room, quoted as data')
    expect(prompt).not.toContain('Original human instruction')
  })

  it('reads the turn the end names, though a later turn of the same member ended first', async () => {
    const { post, finish, ended, newest } = await room()
    const first = await post('@Scout plan')
    const second = await post('@Scout tidy up')
    await finish(first, '@Forge review the plan')
    await finish(second, 'Tidied.')
    await ended(first)
    expect(newest()).toMatchObject({ mentioned: true, rootRequestId: first.id })
  })

  it('reads the whole reply and hands the woken member the part that names it', async () => {
    const { post, reply, newest } = await room()
    const asked = await post('@Scout write it up')
    await reply(asked, `@Forge verify checksum X.\n\n${'detail '.repeat(4_000)}`)
    expect(newest().turns.map((turn) => turn.botId)).toEqual(['bot-1'])
    expect(await sentPrompt(newest().turns[0]!.operationId)).toContain('verify checksum X')
  })

  it('fits the naming excerpt inside the room-history budget, dropping older lines', async () => {
    const { post, reply, newest } = await room()
    const asked = await post('@Scout plan')
    await post('@Forge note this')
    await post(`@Scout ${'context '.repeat(2_800)}`)
    await reply(asked, `@Forge verify checksum X.\n\n${'detail '.repeat(4_000)}`)
    const prompt = await sentPrompt(newest().turns[0]!.operationId)
    const history = /<quoted_room_history>\n([\s\S]*)\n<\/quoted_room_history>/u.exec(prompt)![1]!
    expect(history.length).toBeLessThanOrEqual(24_000)
    expect(history).toContain('verify checksum X')
    expect(history).not.toContain('context context')
  })

  it('delivers the assignment after a long emoji code span', async () => {
    const { post, reply, newest } = await room()
    const asked = await post('@Scout write it up')
    await reply(asked, `\`${'\u{1F600}'.repeat(4_000)}\`\n@Forge verify X\n${'d'.repeat(17_000)}`)
    expect(await sentPrompt(newest().turns[0]!.operationId)).toContain('@Forge verify X')
  })

  it('cuts a naming reply that alone overflows the history budget around its mention', async () => {
    const { post, reply, newest } = await room()
    const asked = await post('@Scout plan')
    await post('@Forge note this')
    await reply(asked, `@Forge check\n${'\\'.repeat(14_000)}`)
    const prompt = await sentPrompt(newest().turns[0]!.operationId)
    const history = /<quoted_room_history>\n([\s\S]*)\n<\/quoted_room_history>/u.exec(prompt)![1]!
    expect(history.length).toBeLessThanOrEqual(24_000)
    expect(history).toContain('@Forge check')
  })

  it('wakes no one when a reply that reached nobody is replayed after its member resumes', async () => {
    const { groups, post, ended, reply, lines } = await room()
    const forge = groups.runtime.bots.list().find((bot) => bot.id === 'bot-1')!
    forge.paused = true
    const asked = await post('@Scout plan')
    await reply(asked, '@Forge review')
    forge.paused = false
    await ended(asked)
    expect(lines()).toHaveLength(1)
  })

  it('reserves nothing when the hand-off cannot all be saved', async () => {
    const { groups, post, reply, lines } = await room()
    const asked = await post('@Scout plan')
    // A line already under the woken line's id makes its save fail midway.
    groups.store.append({
      id: `handoff:${asked.turns[0]!.operationId}:bot-1`,
      groupId: 'elsewhere',
      author: { kind: 'owner' },
      text: '',
      createdAt: asked.createdAt,
      turns: []
    })
    await expect(reply(asked, '@Forge review')).rejects.toThrow()
    const saved = groups.store.message(asked.id)
    expect(saved?.turns[0]?.handedOff).toBeUndefined()
    expect(groups.store.pending()).toEqual([])
    expect(lines()).toHaveLength(1)
  })

  it('wakes no one again when the same end replays after the named member is replaced', async () => {
    const { groups, group, post, ended, reply, lines } = await room()
    const asked = await post('@Scout plan')
    await reply(asked, '@Forge review')
    expect(lines()).toHaveLength(2)
    const sage = groups.runtime.bots.list().find((bot) => bot.id === 'bot-2')!
    await groups.update({
      groupId: group.id,
      revision: groups.store.get(group.id).revision,
      botIds: ['bot-0', 'bot-2']
    })
    sage.name = 'Forge'
    await ended(asked)
    expect(lines()).toHaveLength(2)
  })
})
