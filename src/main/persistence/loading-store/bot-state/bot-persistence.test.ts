import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { createBotLookupIndex } from '../../../../shared/bots/bot-lookup-index'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { BotPersistence } from './bot-persistence'
import type { WriteSchedulingOperations } from '../profile-writing/write-scheduling'

vi.mock('../profile-writing/write-scheduling', () => ({ scheduleSave: vi.fn() }))

function makeBot(id: string, name = id, agent: Bot['agent'] = 'claude'): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `${id}-home`,
    agent,
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: {
      needsPermission: true,
      taskComplete: true,
      couldNotFinish: true
    },
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeBotPersistence(state: {
  bots?: Bot[]
  botsNewerAgents?: Bot[]
  botOrder?: string[]
  botsPermissionDefaultMigrated?: true
}): BotPersistence {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only bot fields on state are read, and scheduleSave is mocked.
  return new BotPersistence({ state } as never, {} as WriteSchedulingOperations)
}

describe('BotPersistence', () => {
  it('keeps a saved bot where it was, so an older cloud keeps taking the same first bots', () => {
    const store = makeBotPersistence({ bots: [makeBot('a'), makeBot('b'), makeBot('c')] })
    store.saveBot(makeBot('a', 'Renamed'))
    expect(store.getBots().map((bot) => [bot.id, bot.name])).toEqual([
      ['a', 'Renamed'],
      ['b', 'b'],
      ['c', 'c']
    ])
    store.saveBot(makeBot('d'))
    expect(store.getBots().map((bot) => bot.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reconstructs interleaved newer-agent order once per state change and clears botOrder when none remain', () => {
    const bots = [makeBot('b'), makeBot('a'), makeBot('added-on-older')]
    const botOrder = ['deleted-on-older', 'a', 'cursor-bot', 'a', 'b']
    const state: {
      bots?: Bot[]
      botsNewerAgents?: Bot[]
      botOrder?: string[]
      botsPermissionDefaultMigrated?: true
    } = {
      bots,
      botsNewerAgents: [makeBot('cursor-bot', 'cursor-bot', 'cursor')],
      botOrder
    }
    const store = makeBotPersistence(state)

    const first = store.getBots()
    expect(first.map((bot) => bot.id)).toEqual(['a', 'cursor-bot', 'b', 'added-on-older'])
    expect(store.getBots()).toBe(first)

    bots[1] = makeBot('a', 'Updated')
    botOrder.reverse()
    expect(store.getBots().map((bot) => [bot.id, bot.name])).toEqual([
      ['b', 'b'],
      ['a', 'Updated'],
      ['cursor-bot', 'cursor-bot'],
      ['added-on-older', 'added-on-older']
    ])

    expect(store.removeBot({ id: 'cursor-bot', hostId: 'local' })).toBe(true)
    expect(state.botsNewerAgents).toBeUndefined()
    expect(state.botOrder).toBeUndefined()
    expect(store.getBots().map((bot) => bot.id)).toEqual(['b', 'a', 'added-on-older'])
  })

  it('rebuilds unbranded caller lookup indexes on same-length element or home changes', () => {
    const bots = [makeBot('scout', 'Scout')]
    const lookup = createBotLookupIndex(() => bots)
    expect(lookup.byHome(folderWorkspaceKey('scout-home'))?.name).toBe('Scout')

    bots[0] = { ...bots[0]!, name: 'Scout 2', folderWorkspaceId: 'moved-home' }
    expect(lookup.byHome(folderWorkspaceKey('scout-home'))).toBeNull()
    expect(lookup.byHome(folderWorkspaceKey('moved-home'))?.name).toBe('Scout 2')
    expect(lookup.byId('scout')?.name).toBe('Scout 2')
  })
})
