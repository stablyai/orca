import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { crc32, deflateSync } from 'node:zlib'
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

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const framed = Buffer.alloc(12 + data.length)
  framed.writeUInt32BE(data.length, 0)
  body.copy(framed, 4)
  framed.writeUInt32BE(crc32(body), 8 + data.length)
  return framed
}

// A real, blank square PNG: what a window's drawing is to the store.
function squarePng(size: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(size * (1 + size * 4)))),
    chunk('IEND', Buffer.alloc(0))
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
  const png = squarePng(512)
  const noPixels = Buffer.concat([png.subarray(0, 33), png.subarray(-12)])
  await writeBotSlackIcon(localBotHomeFilesystem, home, bot.id, look, noPixels)
  expect(await readBotSlackIcon(localBotHomeFilesystem, home, bot)).toBeNull()
  const badPixels = Buffer.concat([
    png.subarray(0, 33),
    chunk('IDAT', Buffer.from('not deflated')),
    png.subarray(-12)
  ])
  await writeBotSlackIcon(localBotHomeFilesystem, home, bot.id, look, badPixels)
  expect(await readBotSlackIcon(localBotHomeFilesystem, home, bot)).toBeNull()
  await writeBotSlackIcon(localBotHomeFilesystem, home, bot.id, look, squarePng(512))
  expect(await readBotSlackIcon(localBotHomeFilesystem, home, bot)).not.toBeNull()
})

it('leaves a drawn icon the cloud failed to take for the next real step, not the retry timer', async () => {
  vi.useFakeTimers()
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
  await writeBotSlackIcon(
    localBotHomeFilesystem,
    folder,
    bot.id,
    botSlackIconLook(bot)!,
    squarePng(512)
  )
  let up = false
  let down = true
  let hold: Promise<void> | null = null
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
        await hold
        if (up) {
          return { ok: true, value: schema.parse(undefined) }
        }
        // Down, or not knowing the bot yet: neither may resend the drawing on a timer.
        return down
          ? { ok: false, status: 503, error: null, retryAfterMs: null }
          : { ok: false, status: 404, error: 'unknown_bot', retryAfterMs: null }
      }
    })
  })

  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toMatchObject({ kind: 'upload' })
  // An outage: the retry timer never sends the icon's bytes again.
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(sent).toHaveLength(1)

  // A real step while the cloud doesn't know the bot: refused, and then not resent on its backoff.
  down = false
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(2))
  await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
  expect(sent).toHaveLength(2)

  // A real step that comes while a send is on its way, which then fails, still gets its own try.
  down = true
  let release = (): void => {}
  hold = new Promise((resolve) => (release = resolve))
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(3))
  sync.changed()
  hold = null
  release()
  await vi.waitFor(() => expect(sent).toHaveLength(4))
  await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
  expect(sent).toHaveLength(4)

  // A real step (any bot write) sends it.
  up = true
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(5))
  expect(sent[4]).toMatchObject({ kind: 'upload' })
  vi.useRealTimers()
})
