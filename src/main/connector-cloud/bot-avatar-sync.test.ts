import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as z from 'zod'
import type { Bot } from '../../shared/bot-types'
import type { ConnectorResult } from './connector-cloud-request'
import { botSlackIconLook } from '../../shared/bots/bot-slack-icon'
import { localBotHomeFilesystem } from '../bots/bot-home'
import { readBotSlackIcon, writeBotSlackIcon } from '../bots/bot-slack-icon-store'
import { BotAvatarSync } from './bot-avatar-sync'

let home: string | null = null

// A PNG's signature, header and end: enough for the store to read it as a whole 512 px icon.
function squarePng(size: number): Buffer {
  const header = Buffer.alloc(25)
  header.writeUInt32BE(13, 0)
  header.write('IHDR', 4, 'latin1')
  header.writeUInt32BE(size, 8)
  header.writeUInt32BE(size, 12)
  header.set([8, 6, 0, 0, 0], 16)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    header,
    Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
  ])
}

afterEach(async () => {
  if (home) {
    await rm(home, { recursive: true, force: true })
  }
})

it('sends a drawn icon only for the look the bot has now, else the plain mascot', async () => {
  home = await mkdtemp(join(tmpdir(), 'bot-slack-icon-'))
  const folder = home
  const bot: Pick<
    Bot,
    'id' | 'folderWorkspaceId' | 'avatar' | 'avatarColor' | 'avatarOutfit' | 'slack' | 'github'
  > = {
    id: 'bot-1',
    folderWorkspaceId: 'home-1',
    avatar: 'mascot:A1',
    avatarColor: '#1f2126',
    avatarOutfit: null,
    slack: { appId: 'A1', teamId: 'T1' },
    github: null
  }
  const sent: unknown[] = []
  const sync = new BotAvatarSync({
    bots: {
      enabled: () => true,
      list: () => [bot],
      readAvatarImage: async () => null,
      slackIcons: { read: () => readBotSlackIcon(localBotHomeFilesystem, folder, bot) }
    },
    cloud: () => ({
      call: async <T extends z.ZodType>(
        _path: string,
        body: unknown,
        schema: T
      ): Promise<ConnectorResult<z.infer<T>>> => {
        sent.push(body)
        return { ok: true, value: schema.parse(undefined) }
      }
    })
  })

  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toEqual({ v: 1, kind: 'mascot', id: 'A1' })

  const drawn = squarePng(512)
  await writeBotSlackIcon(localBotHomeFilesystem, folder, bot.id, botSlackIconLook(bot)!, drawn)
  sync.iconStored(bot.id)
  await vi.waitFor(() => expect(sent).toHaveLength(2))
  expect(sent[1]).toMatchObject({ v: 1, kind: 'upload', png: drawn.toString('base64') })

  // A new outfit set where no window draws it (a phone, the CLI): the old look's icon is not reused.
  bot.avatarOutfit = 'party'
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(3))
  expect(sent[2]).toEqual({ v: 1, kind: 'mascot', id: 'A1' })
})

it('reads an icon cut short by a crash as none, so it is drawn again', async () => {
  home = await mkdtemp(join(tmpdir(), 'bot-slack-icon-'))
  const bot = { id: 'bot-1', avatar: 'mascot:A1', avatarColor: '#1f2126', avatarOutfit: null }
  const look = botSlackIconLook(bot)!
  await writeBotSlackIcon(
    localBotHomeFilesystem,
    home,
    bot.id,
    look,
    squarePng(512).subarray(0, 40)
  )
  expect(await readBotSlackIcon(localBotHomeFilesystem, home, bot)).toBeNull()
  await writeBotSlackIcon(localBotHomeFilesystem, home, bot.id, look, squarePng(512))
  expect(await readBotSlackIcon(localBotHomeFilesystem, home, bot)).not.toBeNull()
})
