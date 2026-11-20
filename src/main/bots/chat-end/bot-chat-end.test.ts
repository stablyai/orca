import '../../runtime/rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
// Ending a bot's side chat against a real session host and orchestration database (fake Codex child).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  coordinatorRunAndTask,
  db,
  host,
  root,
  runtime,
  sendUserMessage
} from '../../runtime/orchestration/terminal-authority/structured-sessions/structured-chat-coordinator-mail-rig.test-fixture'
import { attachParams } from '../../runtime/orchestration/terminal-authority/structured-sessions/structured-chat-coordinator-fake-codex-fixture'
import { runtimeBotChatEndDeps } from '../../runtime/rpc/methods/bots-end-chat'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../shared/agent-session/identity/orca-session-address-prefix'
import { makeTestBot } from '../bot.test-fixture'
import { endBotChat, type BotChatEndRequest } from './bot-chat-end'
import { installBotChatEndGuards } from './bot-chat-end-guards'
import { fenceChatEnd, liftChatEndFence, resetChatEndFencesForTests } from './bot-chat-end-fence'

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
