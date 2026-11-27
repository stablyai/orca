import { expect, it } from 'vitest'
import { applyBotUpdates } from '../../shared/rpc-contract/bots-params'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../native-chat/testing/agent-session-record-test-fixture'
import { keepSessionPicksOnBot } from './bot-session-option-picks'
import { makeTestBot } from './bot.test-fixture'
import { BotLookAroundStore } from './bot-look-around-store'
import { beginRun, EMPTY_BOT_LOOK } from './bot-look-around-state'

it('keeps look session picks off ordinary bot defaults, including on the same provider', async () => {
  let bot = makeTestBot({
    launch: { model: 'gpt-6.2-sol', options: { effort: 'high' } },
    lookAround: {
      on: true,
      every: 'mornings',
      weekdaysOnly: true,
      focus: 'My work',
      agentSetup: {
        agent: 'codex',
        launch: { model: 'gpt-6.2-sol', options: { effort: 'medium' } }
      }
    }
  })
  const before = structuredClone(bot)
  const runs = new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
  runs.update(bot.id, () => ({ state: beginRun(EMPTY_BOT_LOOK, 'look-1', 1), result: null }))
  const host = {
    deps: {
      store: {
        getConversation: (sessionId: string) =>
          agentSessionConversationView(
            agentSessionRecordFixture({
              sessionId,
              location: { workspaceId: `folder:${bot.folderWorkspaceId}` }
            })
          )
      }
    }
  }
  const bots = {
    enabled: () => true,
    list: () => [bot],
    update: async (
      _id: string,
      edit:
        | Parameters<typeof applyBotUpdates>[1]
        | ((current: typeof bot) => Parameters<typeof applyBotUpdates>[1])
    ) => {
      bot = applyBotUpdates(bot, typeof edit === 'function' ? edit(bot) : edit)
      return bot
    }
  }
  const handled = await keepSessionPicksOnBot(
    bots,
    {
      type: 'apply-picks',
      agent: 'codex',
      sessionId: 'look-1',
      picks: [{ modelId: 'gpt-6.2-sol', optionId: 'effort', value: 'low' }]
    },
    host,
    runs
  )
  expect(handled).toBe(true)
  expect(bot).toEqual(before)
  await keepSessionPicksOnBot(
    bots,
    {
      type: 'apply-picks',
      agent: 'codex',
      sessionId: 'ordinary-chat',
      picks: [{ modelId: 'gpt-6.2-sol', optionId: 'effort', value: 'low' }]
    },
    host,
    runs
  )
  expect(bot).toEqual({ ...before, launch: { model: 'gpt-6.2-sol', options: { effort: 'low' } } })
})
