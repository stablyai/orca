import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_PEER_BOT_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY
} from '../../shared/orchestration/orchestration-runtime-capabilities'
import { BotGroupMessageSchema, BotGroupSchema } from '../../shared/bots/bot-group-schema'
import { botGroupRoomMailAddress } from '../../shared/bots/bot-group-room-mail'
import { fixture, groupNativeMocks } from './bot-group-native-runtime.test-fixture'
import { remoteRoomMailArrived } from './bot-group-remote-answers'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

const mocks = groupNativeMocks()

const ATLAS = {
  environmentId: 'env-s',
  botId: 'bot-0',
  chatSessionId: '55555555-5555-4555-8555-555555555555',
  name: 'Atlas',
  avatar: null,
  agent: 'claude' as const
}

/** A group runtime on G whose paired computer S takes bot questions unless told otherwise. */
function remoteFixture(
  options: {
    capabilities?: string[]
    deliver?: () => Promise<unknown>
    status?: () => Promise<void>
  } = {}
) {
  const base = fixture()
  const delivered: Record<string, unknown>[] = []
  const call = vi.fn(async (_environmentId: string, method: string, params: unknown) => {
    if (method === 'status.get') {
      await options.status?.()
      return {
        capabilities: options.capabilities ?? [
          ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY,
          ORCHESTRATION_PEER_BOT_MAIL_RUNTIME_CAPABILITY
        ]
      }
    }
    if (method === 'orchestration.peerMailDeliver') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: peerMailDeliver is always called with its params object.
      delivered.push(params as Record<string, unknown>)
      return (await options.deliver?.()) ?? { ok: true }
    }
    throw new Error(`unexpected ${method}`)
  })
  const ensureRelay = vi.fn()
  const dbOf = base.runtime.getOrchestrationDb.bind(base.runtime)
  Object.assign(base.runtime, {
    readMachineName: () => "Alice's Mac",
    resolveOrchestrationWorkerServer: async (selector: string) => ({
      environmentId: selector,
      name: 'Build Box',
      peerFingerprint: 'fp-s',
      homePeerFingerprint: 'fp-g',
      pairingRevision: 1
    }),
    callOrchestrationWorkerServer: call,
    ensureOrchestrationPeerMailRelay: ensureRelay,
    getOrchestrationDb: () => ({
      ...dbOf(),
      openHomePeerMailConversation: base.orchestration.openHomePeerMailConversation.bind(
        base.orchestration
      ),
      markAsRead: base.orchestration.markAsRead.bind(base.orchestration)
    })
  })
  return { ...base, delivered, call, ensureRelay }
}

/** What S's relay leaves on G: the bot's answer, or S's notice, threaded on the question's id. */
function arrive(
  base: ReturnType<typeof remoteFixture>,
  groupId: string,
  requestId: string,
  reply: { answer: string } | { notice: string }
) {
  const room = botGroupRoomMailAddress(groupId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects conversation_id from an existing row.
  const conversation = base.orchestration.db
    .prepare('SELECT conversation_id FROM peer_mail_conversations WHERE local_party = ?')
    .get(room) as { conversation_id: string }
  base.orchestration.insertPeerMailMessage({
    conversationId: conversation.conversation_id,
    remoteParty: 'orca_session_id:atlas',
    message: {
      id: `msg_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      from: 'Atlas on Build Box',
      to: room,
      subject: 'Re: question',
      body: 'answer' in reply ? reply.answer : reply.notice,
      threadId: requestId,
      ...('answer' in reply
        ? { payload: JSON.stringify({ requestId, botAnswer: { answers: 'your question' } }) }
        : {})
    }
  })
}

async function mixedRoom(base: ReturnType<typeof remoteFixture>) {
  return base.groups.create({ name: 'Crew', botIds: ['bot-0'], remoteBots: [ATLAS] })
}

async function post(
  base: ReturnType<typeof remoteFixture>,
  group: { id: string; revision: number },
  text: string,
  local = true
) {
  const message = await base.groups.send(
    { groupId: group.id, revision: group.revision, messageId: randomUUID(), text },
    { local }
  )
  await vi.waitFor(() =>
    expect(
      (base.groups.store.message(message.id)?.remoteAsks ?? []).every(
        (ask) => ask.state !== 'sending'
      )
    ).toBe(true)
  )
  return base.groups.store.message(message.id)!
}

describe('a group with a bot on another computer', () => {
  it('asks the remote bot by mail and shows its answer under the post', async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    expect(group.remoteMembers).toMatchObject([{ ...ATLAS, computer: 'Build Box' }])
    expect(group.members.map((member) => member.botId)).toEqual(['bot-0'])

    const message = await post(base, group, '@Atlas what is the build status?')
    expect(message.turns).toEqual([])
    const [ask] = message.remoteAsks!
    expect(ask).toMatchObject({ botId: 'bot-0', environmentId: 'env-s', state: 'sent' })
    expect(base.delivered).toEqual([
      expect.objectContaining({
        messageId: ask.requestId,
        to: 'bot:bot-0',
        chat: ATLAS.chatSessionId,
        type: 'question',
        body: expect.stringContaining('what is the build status?')
      })
    ])
    // The reply comes back threaded on the question, to the room, never an agent.
    expect(base.delivered[0]).not.toHaveProperty('threadId')
    expect(base.ensureRelay).toHaveBeenCalledWith('env-s')

    arrive(base, group.id, ask.requestId, { answer: 'Green on main.' })
    remoteRoomMailArrived(base.groups, group.id)
    const { messages } = base.groups.read(group.id)
    expect(messages.at(-1)?.remoteAsks?.[0]).toMatchObject({
      state: 'sent',
      reply: { kind: 'answer', text: 'Green on main.' }
    })
    expect(base.orchestration.getUnreadMessages(botGroupRoomMailAddress(group.id))).toEqual([])
  })

  it("passes a remote answer to the local bot's next turn", async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    const first = await post(base, group, '@Atlas status?')
    arrive(base, group.id, first.remoteAsks![0].requestId, { answer: 'Green on main.' })
    mocks.send.mockClear()
    await base.groups.send(
      { groupId: group.id, revision: group.revision, messageId: randomUUID(), text: '@Scout go' },
      { local: true }
    )
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalled())
    const sent = JSON.stringify(mocks.send.mock.calls[0][0])
    expect(sent).toContain('Green on main.')
    expect(sent).toContain('Atlas (Build Box)')
  })

  it("shows S's notice as its own state, and a later answer replaces it", async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    const { remoteAsks } = await post(base, group, '@Atlas hi')
    const { requestId } = remoteAsks![0]
    arrive(base, group.id, requestId, { notice: 'Atlas is paused; do it yourself or tell...' })
    expect(base.groups.read(group.id).messages[0].remoteAsks![0].reply).toEqual({
      kind: 'notice'
    })
    arrive(base, group.id, requestId, { answer: 'Back now: done.' })
    expect(base.groups.read(group.id).messages[0].remoteAsks![0].reply).toEqual({
      kind: 'answer',
      text: 'Back now: done.'
    })
  })

  it('offers posting again only when the computer gave no answer at all', async () => {
    let failure: Error | null = null
    const base = remoteFixture({
      status: async () => {
        if (failure) {
          throw failure
        }
      }
    })
    const group = await mixedRoom(base)
    failure = Object.assign(new Error('The host did not answer'), {
      code: 'remote_runtime_unavailable'
    })
    expect((await post(base, group, '@Atlas hi')).remoteAsks![0]).toMatchObject({
      state: 'failed',
      error: "Couldn't reach Build Box. The host did not answer. Post again to retry."
    })
    // A computer that answered with a refusal (say, after a re-pair) refuses a new post too.
    failure = new Error('The pairing changed')
    expect((await post(base, group, '@Atlas again')).remoteAsks![0]).toMatchObject({
      state: 'failed',
      error: "Couldn't reach Build Box. The pairing changed"
    })
  })

  it('records a refusal as failed, and a lost acknowledgement as unknown', async () => {
    const refused = remoteFixture({
      deliver: async () => {
        throw new OrchestrationError('bot_chat_not_found', 'Atlas has no chat x')
      }
    })
    const refusedGroup = await mixedRoom(refused)
    const refusal = (await post(refused, refusedGroup, '@Atlas hi')).remoteAsks![0]
    expect(refusal).toMatchObject({ state: 'failed' })
    // Posting again would be refused the same way, so it isn't offered.
    expect(refusal.error).not.toContain('Post again')
    expect(refused.ensureRelay).toHaveBeenCalledWith('env-s')

    const base = remoteFixture({
      deliver: async () => {
        throw new Error('timed out')
      }
    })
    const group = await mixedRoom(base)
    const message = await post(base, group, '@Atlas hi')
    expect(message.remoteAsks![0]).toMatchObject({ state: 'unknown', error: 'timed out' })
    // Its answers can still come back: the relay runs for this conversation.
    expect(base.ensureRelay).toHaveBeenCalledWith('env-s')
    arrive(base, group.id, message.remoteAsks![0].requestId, { answer: 'Got it anyway.' })
    expect(base.groups.read(group.id).messages[0].remoteAsks![0]).toMatchObject({
      state: 'sent',
      reply: { kind: 'answer', text: 'Got it anyway.' }
    })
  })

  it('reads an ask whose handover is no longer running as unknown', async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    const message = await post(base, group, '@Atlas hi')
    // As a restart leaves it: stored as sending, with nothing handing it over.
    base.groups.store.update({
      ...message,
      remoteAsks: message.remoteAsks!.map((ask) => ({ ...ask, state: 'sending' as const }))
    })
    expect(base.groups.read(group.id).messages[0].remoteAsks![0].state).toBe('unknown')
  })

  it('asks remote members only when mentioned or in "all"', async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    const plain = await post(base, group, 'hello')
    expect(plain.turns.map((turn) => turn.botId)).toEqual(['bot-0'])
    // Stamped as posted where remote members could be asked, though none was.
    expect(plain.remoteAsks).toEqual([])
    const everyone = await post(base, group, '@everyone hello')
    expect(everyone.turns).toHaveLength(1)
    expect(everyone.remoteAsks).toHaveLength(1)
  })

  it('refuses a post from anywhere but this computer’s window', async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    await expect(
      base.groups.send(
        { groupId: group.id, revision: group.revision, messageId: randomUUID(), text: 'hi' },
        { local: false }
      )
    ).rejects.toThrow("To post in a group with bots on other computers, use Alice's Mac.")
    expect(base.delivered).toEqual([])
  })

  it('marks unanswered remote asks stopped, without touching an answered one', async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    const answered = await post(base, group, '@Atlas one')
    arrive(base, group.id, answered.remoteAsks![0].requestId, { answer: 'Done.' })
    base.groups.read(group.id)
    const waiting = await post(base, group, '@Atlas two')
    await base.groups.stop(group.id)
    expect(base.groups.store.message(waiting.id)?.remoteAsks?.[0].stopped).toBe(true)
    expect(base.groups.store.message(answered.id)?.remoteAsks?.[0].stopped).toBeUndefined()
  })

  it('needs a bot on this computer, distinct names, and an Orca on S that takes bot questions', async () => {
    const base = remoteFixture()
    await expect(
      base.groups.create({
        name: 'Crew',
        botIds: ['bot-0'],
        remoteBots: [{ ...ATLAS, name: 'scout' }]
      })
    ).rejects.toThrow(
      'scout is already in this group. Members need different names so mentions stay unambiguous.'
    )
    const old = remoteFixture({ capabilities: [ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY] })
    await expect(mixedRoom(old)).rejects.toThrow(
      'Update Orca on Build Box to add its bots to a group.'
    )
    const group = await mixedRoom(base)
    await expect(
      base.groups.update({ groupId: group.id, revision: group.revision, botIds: [] })
    ).rejects.toThrow('This group needs at least one bot on this computer.')
  })

  it('lets members who came to share a name keep editing, but refuses a joining namesake', async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    // Scout, here, is renamed to the remote member's name after it joined.
    base.bots[0].name = 'Atlas'
    const edited = await base.groups.update({
      groupId: group.id,
      revision: group.revision,
      name: 'Crew two'
    })
    expect(edited.name).toBe('Crew two')
    base.bots[1].name = 'atlas'
    await expect(
      base.groups.update({
        groupId: group.id,
        revision: edited.revision,
        botIds: ['bot-0', 'bot-1']
      })
    ).rejects.toThrow('atlas is already in this group.')
  })

  it('compares a joining bot with the name a kept member joined with, not its new one', async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    // Atlas is renamed Orion on its computer; the room still mentions it as Atlas.
    base.bots[1].name = 'Atlas'
    await expect(
      base.groups.update({
        groupId: group.id,
        revision: group.revision,
        botIds: ['bot-0', 'bot-1'],
        remoteBots: [{ ...ATLAS, name: 'Orion' }]
      })
    ).rejects.toThrow('Atlas is already in this group.')
  })

  it("checks a joining member's computer without holding the room's posts", async () => {
    let release: () => void = () => {}
    let checking = false
    const base = remoteFixture({
      status: () =>
        checking ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()
    })
    const group = await base.groups.create({ name: 'Crew', botIds: ['bot-0'] })
    checking = true
    const editing = base.groups.update({
      groupId: group.id,
      revision: group.revision,
      botIds: ['bot-0'],
      remoteBots: [ATLAS]
    })
    await vi.waitFor(() => expect(base.call).toHaveBeenCalled())
    checking = false
    await expect(
      base.groups.send(
        { groupId: group.id, revision: group.revision, messageId: randomUUID(), text: 'hi' },
        { local: true }
      )
    ).resolves.toMatchObject({ turns: [{ botId: 'bot-0' }] })
    release()
    await expect(editing).resolves.toMatchObject({ remoteMembers: [{ botId: 'bot-0' }] })
  })

  it('keeps the remote roster through a local-only edit, and drops it when asked', async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    const edited = await base.groups.update({
      groupId: group.id,
      revision: group.revision,
      botIds: ['bot-0', 'bot-1']
    })
    expect(edited.remoteMembers).toHaveLength(1)
    const statusChecks = base.call.mock.calls.filter(([, method]) => method === 'status.get')
    expect(statusChecks).toHaveLength(1)
    const dropped = await base.groups.update({
      groupId: group.id,
      revision: edited.revision,
      remoteBots: []
    })
    expect(dropped.remoteMembers).toBeUndefined()
  })
})

describe('what a remote member is sent and shown', () => {
  it('leaves out posts an older Orca made after it joined, but not what it joined into', async () => {
    const base = remoteFixture()
    const plain = await base.groups.create({ name: 'Crew', botIds: ['bot-0'] })
    await post(base, plain, 'before it joined')
    const group = await base.groups.update({
      groupId: plain.id,
      revision: plain.revision,
      botIds: ['bot-0'],
      remoteBots: [ATLAS]
    })
    // An older Orca posts here without knowing the room has remote members.
    base.groups.store.append({
      id: randomUUID(),
      groupId: group.id,
      author: { kind: 'owner' },
      text: 'secret from an older build',
      // Room order is by sequence, so a fixed time is enough.
      createdAt: 1_800_000_000_000,
      turns: []
    })
    await post(base, group, 'asked where it can be @Atlas')
    const body = String(base.delivered.at(-1)?.body)
    expect(body).toContain('before it joined')
    expect(body).not.toContain('secret from an older build')
  })

  it("masks a computer's attachment paths in what another member is sent", async () => {
    const base = remoteFixture()
    const beta = { ...ATLAS, botId: 'beta', name: 'Beta', chatSessionId: 'beta-home' }
    const group = await base.groups.create({
      name: 'Crew',
      botIds: ['bot-0'],
      remoteBots: [ATLAS, beta]
    })
    const first = await post(base, group, '@Atlas make a screenshot')
    arrive(base, group.id, first.remoteAsks![0].requestId, {
      answer:
        'Saved /Users/a/.orca/agent-session-attachments/0b5c6f0e-8e8e-4f0e-9a9a-0123456789ab/shot.png'
    })
    await post(base, group, '@Beta what did Atlas make?')
    const body = String(base.delivered.at(-1)?.body)
    expect(body).toContain('Saved [image]')
    expect(body).not.toContain('agent-session-attachments')
    // A folder name with a space doesn't leave the start of the path behind.
    const second = await post(base, group, '@Atlas and another')
    arrive(base, group.id, second.remoteAsks![0].requestId, {
      answer:
        'See /Users/Alice Smith/.orca/agent-session-attachments/0b5c6f0e-8e8e-4f0e-9a9a-0123456789ab/a.png please'
    })
    await post(base, group, '@Beta and that one?')
    const spaced = String(base.delivered.at(-1)?.body)
    expect(spaced).toContain('See [image] please')
    expect(spaced).not.toContain('Alice')
  })

  it('hands a post over once, however often its send is replayed', async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    const input = {
      groupId: group.id,
      revision: group.revision,
      messageId: randomUUID(),
      text: '@Atlas once'
    }
    await Promise.all([
      base.groups.send(input, { local: true }),
      base.groups.send(input, { local: true })
    ])
    await vi.waitFor(() => expect(base.delivered).toHaveLength(1))
    await base.groups.send(input, { local: true })
    expect(base.delivered).toHaveLength(1)
  })

  // Forty posts with 4 MB of answers go through the real SQLite store, which can pass the default
  // 5 s on a loaded CI host.
  it('keeps a page of long remote answers bounded, and says they were shortened', async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    for (let index = 0; index < 40; index++) {
      const message = await post(base, group, `@Atlas ${index}`)
      arrive(base, group.id, message.remoteAsks![0].requestId, { answer: 'x'.repeat(100_000) })
    }
    const page = base.groups.read(group.id)
    expect(JSON.stringify(page).length).toBeLessThan(1_500_000)
    const newest = page.messages.at(-1)!.remoteAsks![0].reply
    expect(newest).toMatchObject({ kind: 'answer', truncated: true })
    expect(newest?.kind === 'answer' && newest.text.length).toBe(16_000)
  }, 60_000)
})

describe('older or damaged records', () => {
  it('keeps asking the remote member, and lands its answer, after an older build rewrote the room', async () => {
    const base = remoteFixture()
    const group = await mixedRoom(base)
    const message = await post(base, group, '@Atlas status?')
    // The older build's edit and post writes: its schemas lack the remote fields, so it drops them.
    for (const [table, id, field] of [
      ['bot_groups', group.id, 'remoteMembers'],
      ['bot_group_messages', message.id, 'remoteAsks']
    ]) {
      const row = base.db.prepare(`SELECT record FROM ${table} WHERE id = ?`).get(id)
      const { [field]: _dropped, ...record } = JSON.parse(String(row?.record))
      base.db.prepare(`UPDATE ${table} SET record = ? WHERE id = ?`).run(JSON.stringify(record), id)
    }

    const { group: threaded } = await base.groups.newThread(group.id)
    expect(threaded.remoteMembers).toMatchObject([{ ...ATLAS, computer: 'Build Box' }])
    arrive(base, group.id, message.remoteAsks![0].requestId, { answer: 'Green on main.' })
    remoteRoomMailArrived(base.groups, group.id)
    expect(base.groups.read(group.id).messages[0].remoteAsks?.[0].reply).toEqual({
      kind: 'answer',
      text: 'Green on main.'
    })
  })

  it('drops an unreadable remote roster or ask list, never the group or post', () => {
    const group = BotGroupSchema.parse({
      id: 'g',
      name: 'Crew',
      hostId: 'local',
      revision: 1,
      folder: 'f',
      folderWorkspaceId: 'w',
      createdAt: 1,
      members: [{ botId: 'b', sessionId: 's' }],
      remoteMembers: [{ broken: true }],
      replyMode: { kind: 'all' }
    })
    expect(group.remoteMembers).toBeUndefined()
    const message = BotGroupMessageSchema.parse({
      id: 'm',
      groupId: 'g',
      sequence: 1,
      author: { kind: 'owner' },
      text: 'hi',
      createdAt: 1,
      turns: [],
      remoteAsks: 'nope'
    })
    expect(message.remoteAsks).toBeUndefined()
  })
})
