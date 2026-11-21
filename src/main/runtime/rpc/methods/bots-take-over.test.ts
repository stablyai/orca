import '../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { DESKTOP_RPC_CALLER } from '../callers/rpc-caller-identity'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BOT_TAKE_OVER_METHOD } from './bots-take-over'

const chat = vi.hoisted(
  (): { outcome: unknown; [k: string]: unknown } & Record<
    'sendToChat' | 'sendToSession' | 'close',
    ReturnType<typeof vi.fn>
  > => ({
    outcome: { kind: 'sent', clientMessageId: 'm1', submission: undefined } satisfies object,
    sendToChat: vi.fn(),
    sendToSession: vi.fn(),
    close: vi.fn(async () => ({ stopped: true }))
  })
)
vi.mock('../../../bots/bot-chat-session', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startBotSession: vi.fn(async () => 'new-chat'),
  closeBotSession: chat.close,
  requireStructuredHost: async () => ({ setUserConversationName: async () => {} }),
  runtimeBotChats: () => ({
    sendToChat: chat.sendToChat.mockImplementation(async () => ({
      sessionId: 'home-chat',
      outcome: chat.outcome,
      fingerprint: 'f'
    })),
    sendToSession: chat.sendToSession.mockImplementation(async (_bot, sessionId: string) => ({
      sessionId,
      outcome: chat.outcome,
      fingerprint: 'f'
    }))
  })
}))

const OWNER = { caller: DESKTOP_RPC_CALLER }

const takeOver = {
  workspace: { id: 'repo::/w/fix', name: 'fix-relay', environment: 'env-1' },
  agents: ['Codex'],
  goal: 'merge it'
}

function setup() {
  const bot = makeTestBot({ id: 'b1', name: 'Release' })
  const update = vi.fn(async () => bot)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots, its webhooks and the runtime id; chats are mocked.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    getWebhooks: () => null,
    bots: { assertEnabled: () => {}, list: () => [bot], update }
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: [BOT_TAKE_OVER_METHOD] })
  const request = (chatKind: 'home' | 'new'): RpcRequest => ({
    id: 'r',
    authToken: 'tok',
    method: 'bots.takeOver',
    params: { botId: 'b1', chat: chatKind, takeOver }
  })
  return { dispatcher, request, update }
}

describe('bots.takeOver', () => {
  it('fails when the new chat refuses the hand-over, and closes that chat', async () => {
    chat.outcome = { kind: 'refused', refusal: { code: 'lease_lost', message: 'Chat is busy.' } }
    chat.close.mockClear()
    const { dispatcher, request, update } = setup()
    expect(await dispatcher.dispatch(request('new'), OWNER)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Chat is busy.') }
    })
    expect(chat.close).toHaveBeenCalledWith(expect.anything(), 'new-chat')
    expect(update).not.toHaveBeenCalled()
  })

  it('fails when Home rejects the hand-over', async () => {
    chat.outcome = {
      kind: 'sent',
      clientMessageId: 'm1',
      submission: { dispatchState: 'rejected', reason: 'Agent exited.' }
    }
    const { dispatcher, request } = setup()
    expect(await dispatcher.dispatch(request('home'), OWNER)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Agent exited.') }
    })
  })

  it('returns the chat that accepted the hand-over', async () => {
    chat.outcome = { kind: 'sent', clientMessageId: 'm1', submission: undefined }
    const { dispatcher, request } = setup()
    expect(await dispatcher.dispatch(request('new'), OWNER)).toMatchObject({
      ok: true,
      result: { sessionId: 'new-chat' }
    })
  })
})
