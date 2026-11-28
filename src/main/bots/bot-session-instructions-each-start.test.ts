import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { botSessionInstructions } from './bot-session-instructions'
import type { BotTurnContext } from './bot-turn-context'

describe('standing instructions on every start', () => {
  it('makes a reopened chat count as given its Tools and Rules only when its agent declares it', async () => {
    const bot = { id: 'b1', name: 'Scout', agent: 'cursor' as const, folderWorkspaceId: 'home' }
    const launchedWith = async (instructionsEachStart: boolean) => {
      const launched: Parameters<BotTurnContext['launched']>[] = []
      await botSessionInstructions(
        {
          launched: (...args) => launched.push(args),
          linkedSkillsLaunched: () => {}
        },
        [bot],
        {
          sessionId: 's1',
          provider: 'cursor',
          instructionsKey: 'recorded-key',
          forkedFrom: undefined,
          location: { workspaceId: folderWorkspaceKey('home') },
          providerHandleChain: [{ nativeId: 'cursor-session' }],
          instructionsEachStart
        },
        '/bots/scout',
        null,
        { readText: async () => null }
      )
      const [, , , , startsFresh, rules] = launched[0]
      return { startsFresh, delivered: rules.delivered, rebuilt: rules.rebuilt }
    }
    expect(await launchedWith(true)).toEqual({ startsFresh: true, delivered: true, rebuilt: true })
    expect(await launchedWith(false)).toEqual({
      startsFresh: false,
      delivered: false,
      rebuilt: false
    })
  })
})
