import '../../runtime/rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
// What holds off new work for a bot chat while it is ended, and who may end one.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  db,
  host,
  root,
  runtime
} from '../../runtime/orchestration/terminal-authority/structured-sessions/structured-chat-coordinator-mail-rig.test-fixture'
import { attachParams } from '../../runtime/orchestration/terminal-authority/structured-sessions/structured-chat-coordinator-fake-codex-fixture'
import { BOT_END_CHAT_METHOD, runtimeBotChatEndDeps } from '../../runtime/rpc/methods/bots-end-chat'
import type { RpcContext } from '../../runtime/rpc/core'
import { makeTestBot } from '../bot.test-fixture'
import { endBotChat } from './bot-chat-end'
import { installBotChatEndGuards } from './bot-chat-end-guards'
import { fenceChatEnd, resetChatEndFencesForTests } from './bot-chat-end-fence'
import { resetBotChatEndOpsForTests } from './bot-chat-end-ops'

const SIDE = COORDINATOR
const BOT = makeTestBot({ folderWorkspaceId: 'bot-home', chatSessionId: PEER_CHAT })

async function backgroundBotChat(sessionId: string): Promise<void> {
  const attached = await host.attach(
    { callerKey: 'test-surface' },
    attachParams(sessionId, root, 'bot-home')
  )
  expect(attached).toMatchObject({ ok: true })
  await vi.waitFor(
    async () => expect((await host.readStatusSummary(sessionId))?.hostExecutionPhase).toBe('ready'),
    WAIT
  )
  await host.setSessionTabVisibility(sessionId, false, undefined, { background: true })
}

async function endIt() {
  const deps = await runtimeBotChatEndDeps(runtime, BOT, SIDE, undefined)
  return endBotChat(deps, { intent: 'end', sessionId: SIDE })
}

beforeEach(() => {
  resetChatEndFencesForTests()
  resetBotChatEndOpsForTests()
  installBotChatEndGuards()
  vi.spyOn(runtime.bots, 'list').mockReturnValue([BOT])
  vi.spyOn(runtime.bots, 'assertEnabled').mockImplementation(() => undefined)
  vi.spyOn(runtime, 'currentLocalStructuredSessionPresentation').mockReturnValue(null)
})

describe('an ended bot chat', () => {
  it('takes no new Run or Dispatch', async () => {
    await backgroundBotChat(SIDE)
    expect(await endIt()).toMatchObject({ outcome: 'ended' })

    expect(() =>
      db.createRun({
        objective: 'late work',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: SIDE as never
      })
    ).toThrow('This chat was ended')
    expect(
      db.runsBoundToCoordinator({
        orcaSessionId: SIDE as never,
        paneKey: null,
        terminalHandle: null
      })
    ).toEqual([])
  })
})

describe('an end whose write has no answer', () => {
  it('reports unknown and keeps refusing new turns', async () => {
    await backgroundBotChat(SIDE)
    const write = host.setSessionTabVisibility.bind(host)
    vi.spyOn(host, 'setSessionTabVisibility').mockImplementation(
      async (sessionId, visible, tabId, options) => {
        if (options?.end) {
          options.check?.()
          throw new Error('disk gone')
        }
        return write(sessionId, visible, tabId, options)
      }
    )

    expect(await endIt()).toEqual({ outcome: 'unknown' })
    expect(await endIt()).toEqual({ outcome: 'unknown' })
    expect(() =>
      db.insertMessage({ from: 'term_x', to: `orca_session_id:${SIDE}`, subject: 'Hi' })
    ).toThrow('This chat is being ended')
  })
})

describe('closing a chat tab while its end is admitted', () => {
  it('does not look for that chat workers to settle', async () => {
    const open = vi.spyOn(runtime, 'getExistingOrchestrationDb')
    fenceChatEnd([SIDE])

    runtime.onStructuredSessionTabHidden(SIDE)
    expect(open).not.toHaveBeenCalled()

    runtime.onStructuredSessionTabHidden(PEER_CHAT)
    expect(open).toHaveBeenCalled()
  })
})

describe('who may end a bot chat', () => {
  const context = (caller: RpcContext['caller']): RpcContext => ({ runtime, caller })
  const ask = (params: Record<string, unknown>, caller: RpcContext['caller']) =>
    BOT_END_CHAT_METHOD.handler(
      BOT_END_CHAT_METHOD.params.parse({ opId: crypto.randomUUID(), botId: BOT.id, ...params }),
      context(caller)
    )

  it('refuses an agent closing a tab, and a paired agent ending one', async () => {
    await backgroundBotChat(SIDE)

    expect(await ask({ chat: SIDE, intent: 'x' }, { kind: 'local-cli' })).toEqual({
      outcome: 'refused',
      refusal: { kind: 'not-owner' }
    })
    expect(
      await ask(
        { chat: SIDE, intent: 'end' },
        { kind: 'paired-device', deviceId: 'd', agent: true }
      )
    ).toEqual({ outcome: 'refused', refusal: { kind: 'not-owner' } })
    expect(host.deps.store.isSessionInBackground(SIDE)).toBe(true)
  })

  it('refuses a declared caller chat this host cannot resolve', async () => {
    await backgroundBotChat(SIDE)

    expect(
      await ask(
        { chat: SIDE, intent: 'end', callerSessionId: '0d9b1c3e-5f7a-4b2c-8e6d-1a3f5c7e9b2d' },
        { kind: 'local-cli' }
      )
    ).toEqual({ outcome: 'refused', refusal: { kind: 'not-owner' } })
  })

  it("lets the owner's terminal end it, and answers a repeat of the op the same way", async () => {
    await backgroundBotChat(SIDE)
    const params = BOT_END_CHAT_METHOD.params.parse({
      opId: crypto.randomUUID(),
      botId: BOT.id,
      chat: SIDE,
      intent: 'end'
    })

    expect(await BOT_END_CHAT_METHOD.handler(params, context({ kind: 'local-cli' }))).toEqual({
      outcome: 'ended',
      title: null
    })
    expect(await BOT_END_CHAT_METHOD.handler(params, context({ kind: 'local-cli' }))).toEqual({
      outcome: 'ended',
      title: null
    })
  })
})
