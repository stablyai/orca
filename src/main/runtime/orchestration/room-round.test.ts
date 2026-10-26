import { describe, expect, it } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../shared/agent-session-wire'
import { OrchestrationDb } from './db'
import { postRoomReply, runRoomRound, stripRoomSpeakerName, type RoomRoundDeps } from './room-round'
import type { StructuredAgentTurnHost } from './send-agent-turn'

const alice = {
  memberId: 'orca_session_id:session_alice_0001',
  name: 'alice',
  isAdmin: true
}
const beta = { memberId: 'orca_session_id:session_beta_0002', name: 'beta' }

const userSource: RoomRoundDeps['fromSource'] = { kind: 'agent', senders: [], orchestration: null }

type SentTurn = { sessionId: string; text: string }
type HostSendAnswer = Awaited<ReturnType<StructuredAgentTurnHost['send']>>

const acceptedAnswer = (value: AgentSessionSendResult): HostSendAnswer => ({
  ok: true,
  replayed: false,
  fence: 0,
  cursor: { epoch: 'e', sequence: 1 },
  value
})

const hostThatSends = () => {
  const sent: SentTurn[] = []
  const send: StructuredAgentTurnHost['send'] = async (_caller, message) => {
    const sessionId = message.envelope.sessionId
    const blocks = message.body.blocks
    sent.push({ sessionId, text: blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n') })
    const clientMessageId = `cm-${sent.length}`
    const submission: AgentJournalSubmission = {
      clientMessageId,
      dispatchState: 'accepted',
      fence: 0,
      payloadFingerprint: '',
      providerItemId: null,
      reason: null,
      submittedAt: Date.now(),
      resolvedAt: null
    }
    return acceptedAnswer({ clientMessageId, submission })
  }
  const waitForSendSettlement: StructuredAgentTurnHost['waitForSendSettlement'] = async () =>
    undefined
  const host: StructuredAgentTurnHost = { send, waitForSendSettlement }
  return { host, sent }
}

const deps = (db: OrchestrationDb, host: StructuredAgentTurnHost): RoomRoundDeps => ({
  db,
  host,
  callerKey: 'test',
  expectedRuntimeFenceFor: () => 0,
  fromSource: userSource
})

describe('stripRoomSpeakerName', () => {
  it('drops a leading "Name:" prefix', () => {
    expect(stripRoomSpeakerName('alice', 'alice: hello')).toBe('hello')
    expect(stripRoomSpeakerName('alice', '**alice**: hi')).toBe('hi')
    expect(stripRoomSpeakerName('alice', 'alice：中文冒号')).toBe('中文冒号')
  })

  it('keeps other text alone', () => {
    expect(stripRoomSpeakerName('alice', 'beta: not me')).toBe('beta: not me')
  })
})

describe('runRoomRound', () => {
  it('posts the user line and prompts the admin in admin mode', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = db.createRoom({ name: 'r', members: [alice, beta] })
    const { host, sent } = hostThatSends()
    const result = await runRoomRound(room, { text: 'hello room' }, deps(db, host))
    expect(result.seq).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].sessionId).toBe('session_alice_0001')
    // the prompt carries the unseen user line
    expect(sent[0].text).toContain('hello room')
    expect(sent[0].text).toContain('alice')
    expect(sent[0].text).toContain('beta')
    // beta sees the user line but not its own (nothing yet)
    const betaUnseen = db.unseenRoomLines(room.id, beta.memberId)
    expect(betaUnseen.map((l) => l.text)).toEqual(['hello room'])
    expect(db.getRoom(room.id)?.members.find((m) => m.member_id === alice.memberId)?.status).toBe(
      'working'
    )
  })

  it('everyone mode prompts the whole roster', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = db.createRoom({
      name: 'r',
      mode: 'everyone',
      members: [alice, beta]
    })
    const { host, sent } = hostThatSends()
    await runRoomRound(room, { text: 'hi all' }, deps(db, host))
    expect(sent.map((s) => s.sessionId)).toEqual(['session_alice_0001', 'session_beta_0002'])
  })

  it('@mention routes to that member', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = db.createRoom({ name: 'r', members: [alice, beta] })
    const { host, sent } = hostThatSends()
    await runRoomRound(room, { text: '@beta hi' }, deps(db, host))
    expect(sent.map((s) => s.sessionId)).toEqual(['session_beta_0002'])
  })

  it('explicit target routes without relying on @mention parsing', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = db.createRoom({ name: 'r', members: [alice, beta] })
    const { host, sent } = hostThatSends()
    await runRoomRound(
      room,
      { text: 'please review this', targetMemberId: beta.memberId },
      deps(db, host)
    )
    expect(sent.map((s) => s.sessionId)).toEqual(['session_beta_0002'])
    const stored = db.db.prepare('SELECT payload FROM room_log WHERE seq = 1').get()
    expect(JSON.parse(typeof stored?.payload === 'string' ? stored.payload : 'null')).toEqual({
      targetMemberId: beta.memberId
    })
  })

  it('marks member as seen so their own unread list is empty', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = db.createRoom({ name: 'r', members: [alice, beta] })
    const { host } = hostThatSends()
    await runRoomRound(room, { text: 'x' }, deps(db, host))
    expect(db.unseenRoomLines(room.id, alice.memberId)).toEqual([])
    // beta was not called, still has the user line unread
    expect(db.unseenRoomLines(room.id, beta.memberId).map((l) => l.text)).toEqual(['x'])
  })
})

describe('postRoomReply', () => {
  it('posts the reply and returns the members it @-called', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = db.createRoom({ name: 'r', members: [alice, beta] })
    const { host } = hostThatSends()
    const result = await postRoomReply(
      room,
      alice.memberId,
      '@beta please draft the outline',
      deps(db, host)
    )
    expect(result.seq).toBe(1)
    expect(result.followUps.map((m) => m.member_id)).toEqual([beta.memberId])
    expect(db.getRoom(room.id)?.members.find((m) => m.member_id === alice.memberId)?.status).toBe(
      'idle'
    )
    const log = db.unseenRoomLines(room.id, beta.memberId)
    expect(log.map((l) => l.text)).toEqual(['@beta please draft the outline'])
  })

  it('member @all does not fan out unless admin', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = db.createRoom({ name: 'r', members: [alice, beta] })
    const { host } = hostThatSends()
    const result = await postRoomReply(room, beta.memberId, '@all ping', deps(db, host))
    expect(result.followUps).toEqual([])
  })

  it('admin @all fans out', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = db.createRoom({ name: 'r', members: [alice, beta] })
    const { host } = hostThatSends()
    const result = await postRoomReply(room, alice.memberId, '@all sync', deps(db, host))
    expect(result.followUps.map((m) => m.member_id)).toEqual([beta.memberId])
  })

  it('a [PASS] posts nothing', async () => {
    const db = new OrchestrationDb(':memory:')
    const room = db.createRoom({ name: 'r', members: [alice, beta] })
    const { host } = hostThatSends()
    const result = await postRoomReply(room, alice.memberId, '[PASS]', deps(db, host))
    expect(result.followUps).toEqual([])
    expect(db.unseenRoomLines(room.id, beta.memberId)).toEqual([])
  })
})
