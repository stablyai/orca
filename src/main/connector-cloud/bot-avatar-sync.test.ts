import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { crc32, deflateSync } from 'node:zlib'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as z from 'zod'
import type { Bot } from '../../shared/bot-types'
import { type ConnectorResult, SIGNED_OUT } from './connector-cloud-request'
import { botSlackIconLook } from '../../shared/bots/bot-slack-icon'
import { localBotHomeFilesystem } from '../bots/bot-home'
import {
  readBotSlackIcon,
  readBotSlackIconShown,
  writeBotSlackIcon,
  writeBotSlackIconShown
} from '../bots/bot-slack-icon-store'
import { BotSlackIconShownRecords } from '../bots/bot-slack-icon-shown'
import { BotAvatarSync } from './bot-avatar-sync'
import { ConnectorCloud } from './connector-cloud'
import type { ConnectorMachine } from './connector-machine'

let home: string | null = null

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const framed = Buffer.alloc(12 + data.length)
  framed.writeUInt32BE(data.length, 0)
  body.copy(framed, 4)
  framed.writeUInt32BE(crc32(body), 8 + data.length)
  return framed
}

// A real, blank square PNG: what a window's drawing is to the store; its size tells drawings apart.
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

// The real record of what the cloud last took, kept beside the drawings, so a new sync reads it as a restart does.
function shownIn(folder: string): { shownRecords: BotSlackIconShownRecords } {
  return {
    shownRecords: new BotSlackIconShownRecords({
      read: (botId) => readBotSlackIconShown(localBotHomeFilesystem, folder, botId),
      write: (botId, shown) => writeBotSlackIconShown(localBotHomeFilesystem, folder, botId, shown),
      exists: () => true
    })
  }
}

it('sends a drawn icon only for the look the bot has now, and the mascot id only before any drawing', async () => {
  home = await mkdtemp(join(tmpdir(), 'bot-slack-icon-'))
  const folder = home
  let bot: Pick<
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
  let reads = 0
  let account = 'acct-1'
  const start = (): BotAvatarSync =>
    new BotAvatarSync({
      bots: {
        enabled: () => true,
        list: () => [bot],
        readAvatarImage: async () => null,
        slackIcons: {
          ...shownIn(folder),
          read: async () => {
            const icon = await readBotSlackIcon(localBotHomeFilesystem, folder, bot)
            reads += 1
            return icon
          }
        }
      },
      cloud: () => ({
        knownAccount: () => account,
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
  let sync = start()

  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(1))
  expect(sent[0]).toEqual({ v: 1, kind: 'mascot', id: 'A1' })

  const drawn = squarePng(512)
  await writeBotSlackIcon(localBotHomeFilesystem, folder, bot.id, botSlackIconLook(bot)!, drawn)
  sync.iconStored(bot.id)
  await vi.waitFor(() => expect(sent).toHaveLength(2))
  expect(sent[1]).toMatchObject({ v: 1, kind: 'upload', png: drawn.toString('base64') })

  // A new outfit not drawn yet: neither the old look's icon nor the mascot id (older art) goes.
  const before = reads
  bot = { ...bot, avatarOutfit: 'party' }
  sync.changed()
  await vi.waitFor(() => expect(reads).toBeGreaterThan(before))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(sent).toHaveLength(2)
  const party = squarePng(520)
  await writeBotSlackIcon(localBotHomeFilesystem, folder, bot.id, botSlackIconLook(bot)!, party)
  sync.iconStored(bot.id)
  await vi.waitFor(() => expect(sent).toHaveLength(3))
  expect(sent[2]).toMatchObject({ v: 1, kind: 'upload', png: party.toString('base64') })

  // Quit after a look's save, before its drawing: the restarted host still leaves the last drawing.
  sync = start()
  const restarted = reads
  bot = { ...bot, avatarOutfit: 'reviewer' }
  sync.changed()
  await vi.waitFor(() => expect(reads).toBeGreaterThan(restarted))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(sent).toHaveLength(3)
  await writeBotSlackIcon(localBotHomeFilesystem, folder, bot.id, botSlackIconLook(bot)!, party)
  sync.iconStored(bot.id)
  await vi.waitFor(() => expect(sent).toHaveLength(4))

  // Another mascot not drawn yet: Slack gets that mascot, not the old one's drawing.
  bot = { ...bot, avatar: 'mascot:G1' }
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(5))
  expect(sent[4]).toEqual({ v: 1, kind: 'mascot', id: 'G1' })
  await writeBotSlackIcon(localBotHomeFilesystem, folder, bot.id, botSlackIconLook(bot)!, drawn)
  sync.iconStored(bot.id)
  await vi.waitFor(() => expect(sent).toHaveLength(6))

  // A drawing another account's cloud took never holds this one's picture back.
  account = 'acct-2'
  bot = { ...bot, avatarOutfit: null }
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(7))
  expect(sent[6]).toEqual({ v: 1, kind: 'mascot', id: 'G1' })
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
      slackIcons: {
        ...shownIn(folder),
        read: () => readBotSlackIcon(localBotHomeFilesystem, folder, bot)
      }
    },
    cloud: () => ({
      knownAccount: () => 'acct-1',
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
  // Answering again or an outage ending doesn't resend a picture the cloud refused outright; a sign-in does.
  sync.retryOwed('answered')
  sync.retryOwed('recovered')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sent).toHaveLength(2)
  sync.retryOwed('signedIn')
  await vi.waitFor(() => expect(sent).toHaveLength(3))
  // The poll's outage ending while a refused picture is on its way doesn't send it again either.
  let releaseRefused = (): void => {}
  hold = new Promise((resolve) => (releaseRefused = resolve))
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(4))
  sync.retryOwed('recovered')
  hold = null
  releaseRefused()
  // Nothing more goes: a fifth send would have to come after the refusal's own file reads.
  await expect(
    vi.waitFor(() => expect(sent).toHaveLength(5), { timeout: 500, interval: 20 })
  ).rejects.toThrow()

  // A real step that comes while a send is on its way, which then fails, still gets its own try.
  down = true
  let release = (): void => {}
  hold = new Promise((resolve) => (release = resolve))
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(5))
  sync.changed()
  hold = null
  release()
  await vi.waitFor(() => expect(sent).toHaveLength(6))
  await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
  expect(sent).toHaveLength(6)

  // The cloud answering again resends it once; failing again, it waits for a real step, not the poll.
  sync.retryOwed('answered')
  await vi.waitFor(() => expect(sent).toHaveLength(7))
  await vi.advanceTimersByTimeAsync(60_000)
  sync.retryOwed('answered')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sent).toHaveLength(7)
  // A real step that fails gets its one resend on the cloud answering again; a sign-in or the poll's own
  // outage recovering always resends.
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(8))
  await vi.advanceTimersByTimeAsync(60_000)
  sync.retryOwed('answered')
  await vi.waitFor(() => expect(sent).toHaveLength(9))
  await vi.advanceTimersByTimeAsync(60_000)
  sync.retryOwed('signedIn')
  await vi.waitFor(() => expect(sent).toHaveLength(10))

  // A sign-in while the one resend is on its way: that resend failing still gets the sign-in's try.
  await vi.advanceTimersByTimeAsync(60_000)
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(11))
  await vi.advanceTimersByTimeAsync(60_000)
  let releaseResend = (): void => {}
  hold = new Promise((resolve) => (releaseResend = resolve))
  sync.retryOwed('answered')
  await vi.waitFor(() => expect(sent).toHaveLength(12))
  sync.retryOwed('signedIn')
  hold = null
  releaseResend()
  await vi.waitFor(() => expect(sent).toHaveLength(13))

  // A real step (any bot write) sends it.
  await vi.advanceTimersByTimeAsync(60_000)
  up = true
  sync.changed()
  await vi.waitFor(() => expect(sent).toHaveLength(14))
  expect(sent[13]).toMatchObject({ kind: 'upload' })
  vi.useRealTimers()
})

it('sends only drawings of the latest look through every edit, a plain look included', async () => {
  home = await mkdtemp(join(tmpdir(), 'bot-slack-icon-'))
  const folder = home
  let bot: Pick<
    Bot,
    'id' | 'folderWorkspaceId' | 'avatar' | 'avatarColor' | 'avatarOutfit' | 'slack' | 'github'
  > = {
    id: 'bot-1',
    folderWorkspaceId: 'home-1',
    avatar: 'mascot:G1',
    avatarColor: '#3a3f4b',
    avatarOutfit: 'reviewer',
    slack: { appId: 'A1', teamId: 'T1' },
    github: null
  }
  const sent: { kind: string; png?: string }[] = []
  const held: (() => void)[] = []
  let hold = true
  let reads = 0
  const sync = new BotAvatarSync({
    bots: {
      enabled: () => true,
      list: () => [bot],
      readAvatarImage: async () => null,
      slackIcons: {
        ...shownIn(folder),
        read: async () => {
          const icon = await readBotSlackIcon(localBotHomeFilesystem, folder, bot)
          reads += 1
          return icon
        }
      }
    },
    cloud: () => ({
      knownAccount: () => 'acct-1',
      call: async <T extends z.ZodType>(
        _path: string,
        body: unknown,
        schema: T
      ): Promise<ConnectorResult<z.infer<T>>> => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sync sends only avatar requests.
        sent.push(body as { kind: string; png?: string })
        // Each upload stays out until the next edit lands, so every edit crosses one in flight.
        if (hold) {
          await new Promise<void>((resolve) => held.push(resolve))
        }
        return { ok: true, value: schema.parse(undefined) }
      }
    })
  })
  const draw = async (size: number): Promise<Buffer> => {
    const png = squarePng(size)
    await writeBotSlackIcon(localBotHomeFilesystem, folder, bot.id, botSlackIconLook(bot)!, png)
    sync.iconStored(bot.id)
    return png
  }
  // Reviewer on dark, then the outfit off, the default tile, and white, each saved while the last send is out.
  await draw(512)
  sync.changed()
  await vi.waitFor(() => expect(held).toHaveLength(1))
  for (const [edit, size] of [
    [{ avatarOutfit: null }, 520],
    [{ avatarColor: null }, 530],
    [{ avatarColor: '#ffffff' }, 540]
  ] as const) {
    const before = sent.length
    bot = { ...bot, ...edit }
    sync.changed()
    await draw(size)
    held.shift()?.()
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(before))
  }
  held.splice(0).forEach((release) => release())
  await vi.waitFor(() => expect(sent.at(-1)?.png).toBe(squarePng(540).toString('base64')))

  // With nothing in flight, the write goes before the window draws its look: Slack keeps the last drawing.
  hold = false
  const before = reads
  bot = { ...bot, avatarOutfit: 'reviewer' }
  sync.changed()
  await vi.waitFor(() => expect(reads).toBeGreaterThan(before))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await draw(550)
  await vi.waitFor(() => expect(sent.at(-1)?.png).toBe(squarePng(550).toString('base64')))
  // The mascot id would have Slack show the cloud's older art: only drawings ever go.
  expect(sent.some((body) => body.kind === 'mascot')).toBe(false)
})

it('keeps no record for a drawing another account may have taken, and keeps it through a sign-out', async () => {
  home = await mkdtemp(join(tmpdir(), 'bot-slack-icon-'))
  const folder = home
  const bot = {
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
  for (const [during, kept] of [
    ['acct-2', false],
    [null, true]
  ] as const) {
    let account: string | null = 'acct-1'
    const icons = shownIn(folder)
    await writeBotSlackIconShown(localBotHomeFilesystem, folder, bot.id, null)
    const sync = new BotAvatarSync({
      bots: {
        enabled: () => true,
        list: () => [bot],
        readAvatarImage: async () => null,
        slackIcons: { ...icons, read: () => readBotSlackIcon(localBotHomeFilesystem, folder, bot) }
      },
      cloud: () => ({
        knownAccount: () => account,
        call: async <T extends z.ZodType>(
          _path: string,
          _body: unknown,
          schema: T
        ): Promise<ConnectorResult<z.infer<T>>> => {
          // Another account signs in, or the host signs out or fences for quit, while the upload is out.
          account = during
          return { ok: true, value: schema.parse(undefined) }
        }
      })
    })
    sync.changed()
    await icons.shownRecords.finalSave()
    const shown = await readBotSlackIconShown(localBotHomeFilesystem, folder, bot.id)
    expect(shown !== null).toBe(kept)
  }
})

it('sends a picture again to another account as it signs in, never again to the same one or while signed out', async () => {
  const bot = {
    id: 'bot-1',
    folderWorkspaceId: 'home-1',
    avatar: 'mascot:A1',
    avatarColor: null,
    avatarOutfit: null,
    slack: { appId: 'A1', teamId: 'T1' },
    github: null
  }
  let account: string | null = 'acct-1'
  const sentAs: (string | null)[] = []
  const sync = new BotAvatarSync({
    bots: {
      enabled: () => true,
      list: () => [bot],
      readAvatarImage: async () => null,
      slackIcons: {
        shownRecords: new BotSlackIconShownRecords({
          read: async () => null,
          write: async () => {},
          exists: () => true
        }),
        read: async () => null
      }
    },
    cloud: () => ({
      knownAccount: () => account,
      call: async <T extends z.ZodType>(
        _path: string,
        _body: unknown,
        schema: T
      ): Promise<ConnectorResult<z.infer<T>>> => {
        sentAs.push(account)
        return { ok: true, value: schema.parse(undefined) }
      }
    })
  })
  sync.changed()
  await vi.waitFor(() => expect(sentAs).toEqual(['acct-1']))
  // Signed out, a bot write sends nothing again.
  account = null
  sync.changed()
  await new Promise((resolve) => setImmediate(resolve))
  expect(sentAs).toEqual(['acct-1'])
  // Another account's sign-in sends it, with no bot write.
  account = 'acct-2'
  sync.retryOwed('signedIn')
  await vi.waitFor(() => expect(sentAs).toEqual(['acct-1', 'acct-2']))
  sync.changed()
  sync.retryOwed('signedIn')
  await new Promise((resolve) => setImmediate(resolve))
  expect(sentAs).toEqual(['acct-1', 'acct-2'])
})

it('saves a record whose save failed when a new drawing is stored, even if its upload hangs', async () => {
  let failing = true
  const onDisk = new Map<string, unknown>()
  const shownRecords = new BotSlackIconShownRecords({
    read: async () => null,
    write: async (botId, shown) => {
      if (failing) {
        throw new Error('disk full')
      }
      onDisk.set(botId, shown)
    },
    exists: () => true
  })
  const drawing = { account: 'a1b2', mascot: 'A1' }
  shownRecords.mark('bot-1', drawing)
  await new Promise((resolve) => setImmediate(resolve))
  shownRecords.answered()
  await new Promise((resolve) => setImmediate(resolve))
  failing = false
  const bot = {
    id: 'bot-1',
    folderWorkspaceId: 'home-1',
    avatar: 'mascot:A1',
    avatarColor: null,
    avatarOutfit: null,
    slack: { appId: 'A1', teamId: 'T1' },
    github: null
  }
  const sync = new BotAvatarSync({
    bots: {
      enabled: () => true,
      list: () => [bot],
      readAvatarImage: async () => null,
      slackIcons: { shownRecords, read: async () => null }
    },
    cloud: () => ({
      knownAccount: () => 'acct-1',
      // The new drawing's upload never answers.
      call: () => new Promise<never>(() => {})
    })
  })
  sync.iconStored('bot-1')
  await vi.waitFor(() => expect(onDisk.get('bot-1')).toEqual(drawing))
})

it('sends again to an account that signed in while an upload was out', async () => {
  const bot = {
    id: 'bot-1',
    folderWorkspaceId: 'home-1',
    avatar: 'mascot:A1',
    avatarColor: null,
    avatarOutfit: null,
    slack: { appId: 'A1', teamId: 'T1' },
    github: null
  }
  let account = 'acct-1'
  const sentAs: string[] = []
  let answer = (): void => {}
  const sync = new BotAvatarSync({
    bots: {
      enabled: () => true,
      list: () => [bot],
      readAvatarImage: async () => null,
      slackIcons: {
        shownRecords: new BotSlackIconShownRecords({
          read: async () => null,
          write: async () => {},
          exists: () => true
        }),
        read: async () => null
      }
    },
    cloud: () => ({
      knownAccount: () => account,
      call: async <T extends z.ZodType>(
        _path: string,
        _body: unknown,
        schema: T
      ): Promise<ConnectorResult<z.infer<T>>> => {
        sentAs.push(account)
        if (sentAs.length === 1) {
          await new Promise<void>((resolve) => (answer = resolve))
        }
        return { ok: true, value: schema.parse(undefined) }
      }
    })
  })
  sync.changed()
  await vi.waitFor(() => expect(sentAs).toEqual(['acct-1']))
  account = 'acct-2'
  sync.retryOwed('signedIn')
  answer()
  await vi.waitFor(() => expect(sentAs).toEqual(['acct-1', 'acct-2']))
})

it('takes up the account a sign-in left while a sign-out was running', () => {
  let account: string | null = 'acct-1'
  const connector = new ConnectorCloud({
    userDataPath: join(tmpdir(), 'connector-cloud-no-such-profile'),
    origin: 'https://cloud.invalid',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a connector that never connects never uses its machine.
    machine: {} as ConnectorMachine,
    account: () => account,
    isFenced: () => false,
    mintFor: () => {
      throw new Error('not minted here')
    }
  })
  connector.signOutStarted()
  account = 'acct-2'
  connector.accountChanged()
  expect(connector.knownAccount()).toBeNull()
  connector.signOutFinished()
  expect(connector.knownAccount()).toBe('acct-2')
})

it('sends nothing and starts no timer for a look changed while signed out', async () => {
  vi.useFakeTimers()
  try {
    let bot = {
      id: 'bot-1',
      folderWorkspaceId: 'home-1',
      avatar: 'mascot:A1',
      avatarColor: '#1f2126',
      avatarOutfit: null,
      slack: { appId: 'A1', teamId: 'T1' },
      github: null
    }
    let calls = 0
    const sync = new BotAvatarSync({
      bots: {
        enabled: () => true,
        list: () => [bot],
        readAvatarImage: async () => null,
        slackIcons: {
          shownRecords: new BotSlackIconShownRecords({
            read: async () => null,
            write: async () => {},
            exists: () => true
          }),
          read: async () => null
        }
      },
      cloud: () => ({
        knownAccount: () => null,
        call: async () => {
          calls += 1
          return SIGNED_OUT
        }
      })
    })
    bot = { ...bot, avatarColor: '#ffffff' }
    sync.changed()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(calls).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
