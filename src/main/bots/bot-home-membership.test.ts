import { describe, expect, it } from 'vitest'
import { isInBotHome } from './bot-home-membership'

const bots = { list: () => [{ folderWorkspaceId: 'home' }] }

describe('isInBotHome', () => {
  it("names only a chat in a bot's home", () => {
    expect(isInBotHome(bots, { workspaceId: 'folder:home' })).toBe(true)
    expect(isInBotHome(bots, { workspaceId: 'folder:elsewhere' })).toBe(false)
    expect(isInBotHome(bots, undefined)).toBe(false)
    expect(isInBotHome(undefined, { workspaceId: 'folder:home' })).toBe(false)
  })
})
