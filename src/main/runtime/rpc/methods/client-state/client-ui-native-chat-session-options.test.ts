import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { RpcRequest } from '../../core'
import { RpcDispatcher } from '../../dispatcher'
import { CLIENT_UI_METHODS } from './client-ui'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { makeTestBot } from '../../../../bots/bot.test-fixture'

function makeHost() {
  let bot: Bot = makeTestBot({ agent: 'claude', folderWorkspaceId: 'home' })
  const fake = {
    getRuntimeId: () => 'test-runtime',
    bots: {
      enabled: () => true,
      list: () => [bot],
      update: vi.fn(
        async (_id: string, edit: (current: Bot) => { launch?: Bot['launch'] | null }) => {
          const { launch } = edit(bot)
          bot = { ...bot, ...(launch ? { launch } : {}) }
          return bot
        }
      )
    },
    updateClientNativeChatSessionOptions: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the members above.
  const runtime = fake as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: CLIENT_UI_METHODS })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bot lookup reads only a conversation's location.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        getConversation: (sessionId: string) => ({
          location: {
            workspaceId: sessionId === 'bot-look' ? 'folder:home' : 'repo::/code'
          }
        })
      }
    }
  } as never)
  let id = 0
  const pickHaiku = (sessionId?: string) => {
    const request: RpcRequest = {
      id: `req-${++id}`,
      authToken: 'tok',
      method: 'settings.mutateNativeChatSessionOptions',
      params: {
        type: 'apply-picks',
        agent: 'claude',
        picks: [
          {
            modelId: 'claude-haiku-5-5',
            optionId: 'model',
            value: 'claude-haiku-5-5'
          }
        ],
        ...(sessionId ? { sessionId } : {})
      }
    }
    return dispatcher.dispatch(request, {})
  }
  return { fake, pickHaiku, bot: () => bot }
}

afterEach(() => setStructuredAgentSessionHost(null))

describe('settings.mutateNativeChatSessionOptions', () => {
  it("keeps a pick made in a bot's look-around on the bot and leaves the owner's chat default alone", async () => {
    const host = makeHost()

    expect(await host.pickHaiku('bot-look')).toMatchObject({ ok: true })
    expect(host.bot().launch).toEqual({ model: 'claude-haiku-5-5' })
    expect(host.fake.updateClientNativeChatSessionOptions).not.toHaveBeenCalled()
  })

  it("remembers a pick in the owner's own chat, or from an older client, as their chat default", async () => {
    const host = makeHost()

    await host.pickHaiku('plain-chat')
    await host.pickHaiku()
    expect(host.fake.updateClientNativeChatSessionOptions).toHaveBeenCalledTimes(2)
    expect(host.fake.bots.update).not.toHaveBeenCalled()
  })
})
