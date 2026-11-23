import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { BotPersistence } from './bot-persistence'
import type { WriteSchedulingOperations } from '../profile-writing/write-scheduling'

vi.mock('../profile-writing/write-scheduling', () => ({ scheduleSave: vi.fn() }))

function makeBot(id: string, name = id): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: '',
    agent: 'claude',
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

describe('BotPersistence.saveBot', () => {
  it('keeps a saved bot where it was, so an older cloud keeps taking the same first bots', () => {
    const runtime = {
      state: { bots: [makeBot('a'), makeBot('b'), makeBot('c')] }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only state.bots is read, and scheduleSave is mocked.
    const store = new BotPersistence(runtime as never, {} as WriteSchedulingOperations)
    store.saveBot(makeBot('a', 'Renamed'))
    expect(store.getBots().map((bot) => [bot.id, bot.name])).toEqual([
      ['a', 'Renamed'],
      ['b', 'b'],
      ['c', 'c']
    ])
    store.saveBot(makeBot('d'))
    expect(store.getBots().map((bot) => bot.id)).toEqual(['a', 'b', 'c', 'd'])
  })
})
