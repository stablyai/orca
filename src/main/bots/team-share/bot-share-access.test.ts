import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../shared/bot-types'
import type { BotShare } from '../../../shared/bots/bot-team-shares'
import { makeTestBot } from '../bot.test-fixture'
import { botShareListedBots, removeBotShare, type BotShareDevices } from './bot-share-access'

const alice: BotShare = {
  kind: 'account',
  shareId: 'share-alice',
  accountId: 'acct-alice',
  name: 'Alice',
  email: 'alice@example.com',
  addedAt: 1
}
const bob: BotShare = { kind: 'invite', shareId: 'share-bob', email: 'bob@example.com', addedAt: 1 }

describe('teammate access from the share list', () => {
  it('lists a teammate the shared bot alone, never whom else it is shared with', () => {
    const shared = makeTestBot({ id: 'bot-1', shares: [alice, bob] })
    const other = makeTestBot({ id: 'bot-2', shares: [bob] })
    const listed = botShareListedBots([shared, other], { botId: 'bot-1' })
    expect(listed.map((bot) => bot.id)).toEqual(['bot-1'])
    expect(JSON.stringify(listed)).not.toMatch(/example\.com|share-alice|share-bob/)
  })

  it('lists a teammate the bot’s row and avatar, never its people, connectors or the owner’s chats', () => {
    const shared = makeTestBot({
      id: 'bot-1',
      avatarColor: '#3366ff',
      members: [{ id: 'U-SECRET', name: 'Secret Person', source: 'slack', workspaceId: 'T1' }],
      handedPairedWorkspaces: [{ environmentId: 'env-secret', worktreeId: 'wt-secret' }],
      slack: { appId: 'A-SECRET', teamId: 'T-SECRET', ownerUserId: 'U-OWNER' },
      chatSessionId: 'home-chat-secret',
      shares: [alice]
    })
    const [listed] = botShareListedBots([shared], { botId: 'bot-1' })
    expect(listed).toMatchObject({
      id: 'bot-1',
      name: shared.name,
      folderWorkspaceId: shared.folderWorkspaceId,
      agent: shared.agent,
      avatarColor: '#3366ff',
      members: [],
      slack: null,
      chatSessionId: null
    })
    expect(JSON.stringify(listed)).not.toMatch(/SECRET|secret|U-OWNER|permissionMode/)
  })

  it('ends a removed account’s devices on that bot, and no one’s for a removed invite', async () => {
    let saved: Bot = makeTestBot({ id: 'bot-1', shares: [alice, bob] })
    const revokeBotShareDevices = vi.fn<BotShareDevices['revokeBotShareDevices']>(async () => true)
    const deps = {
      update: async (_botId: string, edit: (bot: Pick<Bot, 'shares'>) => Pick<Bot, 'shares'>) => {
        saved = { ...saved, ...edit(saved) }
        return saved
      },
      devices: { revokeBotShareDevices, mintBotShareOffer: vi.fn() }
    }
    await removeBotShare(deps, 'bot-1', 'share-bob')
    expect(revokeBotShareDevices).not.toHaveBeenCalled()
    await removeBotShare(deps, 'bot-1', 'share-alice')
    expect(revokeBotShareDevices).toHaveBeenCalledExactlyOnceWith('bot-1', 'acct-alice')
    expect(saved.shares).toEqual([])
  })
})
