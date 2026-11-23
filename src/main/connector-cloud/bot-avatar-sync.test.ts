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

afterEach(async () => {
  if (home) {
    await rm(home, { recursive: true, force: true })
  }
})

it('sends a drawn icon only for the look the bot has now, else the plain mascot', async () => {
  home = await mkdtemp(join(tmpdir(), 'bot-slack-icon-'))
  const folder = home
  const bot: Pick<Bot, 'id' | 'avatar' | 'avatarColor' | 'avatarOutfit' | 'slack' | 'github'> = {
    id: 'bot-1',
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

  const drawn = Buffer.from('drawn icon')
  await writeBotSlackIcon(localBotHomeFilesystem, folder, botSlackIconLook(bot)!, drawn)
  sync.iconStored(bot.id)
  await vi.waitFor(() => expect(sent).toHaveLength(2))
  expect(sent[1]).toMatchObject({ v: 1, kind: 'upload', png: drawn.toString('base64') })

  // A new outfit set where no window draws it (a phone, the CLI): the old look's icon is not reused.
  bot.avatarOutfit = 'party'
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(3))
  expect(sent[2]).toEqual({ v: 1, kind: 'mascot', id: 'A1' })
})
