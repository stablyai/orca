import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import type { NativeChatSessionOptionSettingsMutation } from '../../shared/native-chat/input/native-chat-session-options'
import { keepSessionPicksOnBot } from './bot-session-option-picks'
import { makeTestBot } from './bot.test-fixture'

const HOME = 'w1'

function harness(bot: Bot = makeTestBot({ agent: 'claude', folderWorkspaceId: HOME })) {
  let saved = bot
  const bots = {
    enabled: () => true,
    list: () => [saved],
    update: vi.fn(
      async (_id: string, edit: (current: Bot) => { launch?: Bot['launch'] | null }) => {
        const { launch } = edit(saved)
        saved = { ...saved, ...(launch ? { launch } : {}) }
        return saved
      }
    )
  }
  // A session in the bot's home, and one in a plain workspace.
  const host = {
    deps: {
      store: {
        getConversation: (sessionId: string) =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bot lookup reads only a conversation's location.
          ({
            location: {
              workspaceId: sessionId === 'bot-chat' ? `folder:${HOME}` : 'repo::/code'
            }
          }) as never
      }
    }
  }
  return { bots, host }
}

const haikuPick = (sessionId: string): NativeChatSessionOptionSettingsMutation => ({
  type: 'apply-picks',
  agent: 'claude',
  picks: [
    {
      modelId: 'claude-haiku-5-5',
      optionId: 'model',
      value: 'claude-haiku-5-5'
    }
  ],
  sessionId
})

describe("a model pick in a bot's conversation", () => {
  it('saves nothing when the bot already runs the picked model', async () => {
    const { bots, host } = harness(
      makeTestBot({
        agent: 'claude',
        folderWorkspaceId: HOME,
        launch: { model: 'claude-haiku-5-5' }
      })
    )

    expect(await keepSessionPicksOnBot(bots, haikuPick('bot-chat'), host)).toBe(true)
    expect(bots.update).not.toHaveBeenCalled()
  })

  it("still keeps it off the owner's default when the bot cannot be saved", async () => {
    const { bots, host } = harness()
    bots.update.mockRejectedValueOnce(new Error('disk full'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await keepSessionPicksOnBot(bots, haikuPick('bot-chat'), host)).toBe(true)
    warn.mockRestore()
  })
})
