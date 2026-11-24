import '../../runtime/rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
// Ending a bot's side chat against a real session host and orchestration database (fake Codex child).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  openChat,
  coordinatorRunAndTask,
  db,
  host,
  root,
  runtime,
  sendUserMessage
} from '../../runtime/orchestration/terminal-authority/structured-sessions/structured-chat-coordinator-mail-rig.test-fixture'
import {
  attachParams,
  operationId
} from '../../runtime/orchestration/terminal-authority/structured-sessions/structured-chat-coordinator-fake-codex-fixture'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER } from '../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-wiring'
import { structuredQueueHold } from '../../native-chat/agent-session-wire/delivery/structured-agent-session-queued-gate'
import { runtimeBotChatEndDeps } from '../../runtime/rpc/methods/bots-end-chat'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/agent-session/identity/orca-session-address-prefix'
import { makeTestBot } from '../bot.test-fixture'
import { endBotChat, type BotChatEndRequest } from './bot-chat-end'
import { installBotChatEndGuards } from './bot-chat-end-guards'
import {
  CHAT_ENDED,
  fenceChatEnd,
  liftChatEndFence,
  resetChatEndFencesForTests
} from './bot-chat-end-fence'

const SIDE = COORDINATOR
const SIDE_ADDRESS = `${ORCA_SESSION_ADDRESS_PREFIX}${SIDE}`
const BOT = makeTestBot({ folderWorkspaceId: 'bot-home', chatSessionId: PEER_CHAT })

async function openBotChat(sessionId: string, place: 'tab' | 'background'): Promise<void> {
  const attached = await host.attach(
    { callerKey: 'test-surface' },
    attachParams(sessionId, root, 'bot-home')
  )
  expect(attached).toMatchObject({ ok: true })
  await vi.waitFor(
    async () => expect((await host.readStatusSummary(sessionId))?.hostExecutionPhase).toBe('ready'),
    WAIT
  )
  await host.setSessionTabVisibility(
    sessionId,
    place === 'tab',
    undefined,
    place === 'background' ? { background: true } : undefined
  )
}

async function end(request: Partial<BotChatEndRequest> = {}, chat: string = SIDE) {
  const deps = await runtimeBotChatEndDeps(runtime, BOT, chat, undefined)
  return endBotChat(deps, { intent: 'end', sessionId: chat, ...request })
}

/** A send as `callerKey` makes it: another window's composer, or Orca continuing a cut-off turn. */
function sendAs(callerKey: string, sessionId: string, text: string) {
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text }]
  }
  return host.send(
    { callerKey },
    {
      envelope: {
        sessionId,
        clientOperationId: operationId(),
        expectedRuntimeFence: host.deps.store.getRecord(sessionId)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId,
          fields: { body }
        })
      },
      body
    }
  )
}

function messageId(result: Record<string, unknown>): string {
  const message = result.message
  if (typeof message === 'object' && message !== null && 'id' in message) {
    return String(message.id)
  }
  return expect.fail('no message in the send result')
}

const idleWork = {
  working: () => false,
  hasActionablePrompt: () => false,
  actionablePrompts: () => [],
  activeTurnId: () => null
}

beforeEach(() => {
  resetChatEndFencesForTests()
  installBotChatEndGuards()
  vi.spyOn(runtime.bots, 'list').mockReturnValue([BOT])
  // The rig's bot home is no workspace the runtime lays out; its chats have no window presentation.
  vi.spyOn(runtime, 'currentLocalStructuredSessionPresentation').mockReturnValue(null)
})

describe('ending a bot side chat', () => {
  it('ends an idle background chat: it leaves the background and takes no turn until reopened', async () => {
    await openBotChat(SIDE, 'background')

    expect(await end()).toEqual({ outcome: 'ended', title: null })
    expect(host.deps.store.isSessionEnded(SIDE)).toBe(true)
    expect(host.deps.store.isSessionInBackground(SIDE)).toBe(false)
    expect(await sendUserMessage(SIDE, 'still there?')).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })

    await host.setSessionTabVisibility(SIDE, true)
    expect(host.deps.store.isSessionEnded(SIDE)).toBe(false)
    expect(await sendUserMessage(SIDE, 'back again')).toMatchObject({ ok: true })
  })

  it('answers a second end of the same chat as already ended', async () => {
    await openBotChat(SIDE, 'background')
    await end()

    expect(await end()).toEqual({ outcome: 'already-ended' })
  })

  it('keeps a chat with unread mail in the background', async () => {
    await openBotChat(SIDE, 'background')
    db.insertMessage({
      from: 'term_someone',
      to: SIDE_ADDRESS,
      subject: 'Waiting',
      body: 'read me'
    })

    expect(await end()).toEqual({ outcome: 'kept', reasons: [{ kind: 'unread', count: 1 }] })
    expect(host.deps.store.isSessionInBackground(SIDE)).toBe(true)
    expect(host.deps.store.isSessionEnded(SIDE)).toBe(false)
  })

  it('keeps a chat while a plain question it sent, or one it read, waits for its answer', async () => {
    // An ordinary chat outside the bot's home, so the mail is plain point-to-point.
    const peerId = '2c8e4b1a-6d3f-4a9e-b7c2-9f1e3d5a7b60'
    await openChat(peerId)
    await openBotChat(SIDE, 'background')
    const PEER = `${ORCA_SESSION_ADDRESS_PREFIX}${peerId}`
    const sent = messageId(
      await call(
        'orchestration.send',
        { to: PEER, subject: 'Which branch?', type: 'question' },
        { sessionId: SIDE }
      )
    )
    expect(await end()).toEqual({ outcome: 'kept', reasons: [{ kind: 'questions', count: 1 }] })

    // Asked inside an existing thread, so the reply lands on its root and must name the question.
    const plan = db.insertMessage({ from: PEER, to: SIDE_ADDRESS, subject: 'Plan' })
    const asked = db.insertMessage({
      from: PEER,
      to: SIDE_ADDRESS,
      subject: 'Ready?',
      type: 'question',
      threadId: plan.id
    })
    db.markAsRead([plan.id, asked.id])
    expect(await end()).toEqual({
      outcome: 'kept',
      reasons: [
        { kind: 'requests', count: 1 },
        { kind: 'questions', count: 1 }
      ]
    })

    // Each answered by the other side, the answer read: nothing is owed. The chat's reply goes
    // through `orchestration reply`, which names the question it answers.
    await call('orchestration.reply', { id: asked.id, body: 'yes' }, { sessionId: SIDE })
    const answer = db.insertMessage({
      from: PEER,
      to: SIDE_ADDRESS,
      subject: 'Re: Which branch?',
      body: 'main',
      threadId: sent,
      // As the peer's own `orchestration reply` writes it.
      payload: JSON.stringify({ replyTo: sent })
    })
    db.markAsRead([answer.id])
    expect(await end()).toEqual({ outcome: 'ended', title: null })
  })

  it('keeps a chat until each question asked of it has its own reply, in one thread', async () => {
    const peerId = '6f1d2a3b-4c5e-4f60-8a7b-9c0d1e2f3a4b'
    await openChat(peerId)
    await openBotChat(SIDE, 'background')
    const PEER = `${ORCA_SESSION_ADDRESS_PREFIX}${peerId}`
    const q1 = db.insertMessage({
      from: PEER,
      to: SIDE_ADDRESS,
      subject: 'Ready?',
      type: 'question'
    })
    const q2 = db.insertMessage({
      from: PEER,
      to: SIDE_ADDRESS,
      subject: 'Tested?',
      type: 'question',
      threadId: q1.id
    })
    db.markAsRead([q1.id, q2.id])

    // Both replies land in Q1's thread; only the question each names is answered.
    await call('orchestration.reply', { id: q2.id, body: 'yes, tested' }, { sessionId: SIDE })
    expect(await end()).toEqual({ outcome: 'kept', reasons: [{ kind: 'requests', count: 1 }] })
    await call('orchestration.reply', { id: q1.id, body: 'ready' }, { sessionId: SIDE })
    expect(await end()).toEqual({ outcome: 'ended', title: null })
  })

  it('keeps a chat that ran workers, and never stops its agent', async () => {
    await openBotChat(SIDE, 'background')
    await coordinatorRunAndTask()

    expect(await end()).toEqual({ outcome: 'kept', reasons: [{ kind: 'ran-workers' }] })
    expect(host.hasSession(SIDE)).toBe(true)
  })

  it('never ends the Home Chat', async () => {
    await openBotChat(PEER_CHAT, 'tab')

    expect(await end({}, PEER_CHAT)).toEqual({ outcome: 'refused', refusal: { kind: 'home' } })
    expect(host.getSessionTabId(PEER_CHAT)).not.toBeNull()
  })

  it('refuses a group member twice, leaving it in the background', async () => {
    const member = 'bot-group-member-1'
    await openBotChat(SIDE, 'background')

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await end({}, member)).toEqual({
        outcome: 'refused',
        refusal: { kind: 'not-found' }
      })
    }
    expect(host.deps.store.isSessionInBackground(SIDE)).toBe(true)
  })
})

describe('when the idle release does not stop the agent', () => {
  it('reports what the release saw, once: a reply in progress, or an agent still stopping', async () => {
    await openBotChat(SIDE, 'background')
    const release = vi.spyOn(host, 'releaseIdleSession')

    release.mockResolvedValueOnce('busy')
    expect(await end()).toEqual({ outcome: 'kept', reasons: [{ kind: 'replying' }] })
    release.mockResolvedValueOnce('unconfirmed')
    expect(await end()).toEqual({ outcome: 'kept', reasons: [{ kind: 'stopping' }] })

    expect(release).toHaveBeenCalledTimes(2)
    expect(host.deps.store.isSessionInBackground(SIDE)).toBe(true)
    expect(host.deps.store.isSessionEnded(SIDE)).toBe(false)
  })

  it('keeps a chat with no agent loaded that still owes work, at the fence tick and at the write', async () => {
    await openBotChat(SIDE, 'background')
    // A delivery, acquire abort, provider child work or ingress still keyed to the unloaded chat.
    let owing = true
    vi.spyOn(host.reads, 'owesUnloadedWork').mockImplementation((id) => owing && id === SIDE)
    expect(await end()).toEqual({ outcome: 'kept', reasons: [{ kind: 'stopping' }] })
    expect(host.hasSession(SIDE)).toBe(false)

    // Admitted at the tick; the work arrives while the fenced reads run, before the write's check.
    owing = false
    const cutOf = host.restartResume.cutOf.bind(host.restartResume)
    vi.spyOn(host.restartResume, 'cutOf').mockImplementationOnce(async (id) => {
      owing = true
      return cutOf(id)
    })
    expect(await end()).toEqual({ outcome: 'kept', reasons: [{ kind: 'stopping' }] })
    expect(host.deps.store.isSessionInBackground(SIDE)).toBe(true)
    expect(host.deps.store.isSessionEnded(SIDE)).toBe(false)
  })
})

describe('every way a turn can start in an ended chat', () => {
  it("refuses another window's send, Orca's own continuation and its queue, until reopened", async () => {
    await openBotChat(SIDE, 'background')
    expect(await end()).toEqual({ outcome: 'ended', title: null })
    const ended = { ok: false, refusal: { message: CHAT_ENDED } }

    expect(await sendAs('second-window', SIDE, 'stale draft')).toMatchObject(ended)
    expect(
      await sendAs(STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER, SIDE, 'Continue')
    ).toMatchObject(ended)
    const record = () => host.deps.store.getRecord(SIDE)
    expect(structuredQueueHold({ record: record(), work: idleWork })).toBe('blocked')

    await host.setSessionTabVisibility(SIDE, true)
    expect(structuredQueueHold({ record: record(), work: idleWork })).toBeNull()
    expect(
      await sendAs(STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER, SIDE, 'Continue')
    ).toMatchObject({ ok: true })
  })
})

describe('closing a bot side chat tab ("x")', () => {
  it('does nothing when the tab it names is no longer the one showing', async () => {
    await openBotChat(SIDE, 'tab')
    const closed = host.deps.store.getSessionTabShowing(SIDE)!
    await host.setSessionTabVisibility(SIDE, false, undefined, { background: true })
    await host.setSessionTabVisibility(SIDE, true)

    expect(await end({ intent: 'x', showing: closed })).toEqual({ outcome: 'superseded' })
    expect(host.getSessionTabId(SIDE)).not.toBeNull()
  })

  it('ends an idle chat from its tab', async () => {
    await openBotChat(SIDE, 'tab')
    const showing = host.deps.store.getSessionTabShowing(SIDE)!

    expect(await end({ intent: 'x', showing })).toEqual({ outcome: 'ended', title: null })
    expect(host.getSessionTabId(SIDE)).toBeNull()
    expect(host.deps.store.isSessionEnded(SIDE)).toBe(true)
  })

  it('moves a chat that owes something to the background, as a closed tab always did', async () => {
    await openBotChat(SIDE, 'tab')
    await coordinatorRunAndTask()
    const showing = host.deps.store.getSessionTabShowing(SIDE)!

    expect(await end({ intent: 'x', showing })).toEqual({
      outcome: 'kept',
      reasons: [{ kind: 'ran-workers' }],
      background: true
    })
    expect(host.getSessionTabId(SIDE)).toBeNull()
    expect(host.deps.store.isSessionInBackground(SIDE)).toBe(true)
  })
})

describe('while a chat is being ended', () => {
  it('refuses new mail to it with no effect, and takes it again after', async () => {
    await openBotChat(SIDE, 'background')
    const mail = {
      from: 'term_someone',
      to: SIDE_ADDRESS,
      subject: 'Hi',
      body: 'hello'
    }
    fenceChatEnd([SIDE])

    expect(() => db.insertMessage(mail)).toThrow('This chat is being ended')
    expect(db.getUndeliveredUnreadMessages(mail.to, undefined, {})).toHaveLength(0)

    liftChatEndFence([SIDE])
    expect(db.insertMessage(mail).to_handle).toBe(mail.to)
  })
})
