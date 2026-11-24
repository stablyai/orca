import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import type { Store } from '../persistence/loading-store/store'
import { BOT_AVATAR_FILE, mascotAvatar } from '../../shared/bot-avatar'
import { RuntimeProjectGroupController } from '../runtime/repositories/runtime-project-group-controller'
import { BotController } from './bot-controller'
import { botsRootFolder, localBotHomeFilesystem } from './bot-home'

/** A PNG header for a square image; `salt` changes the bytes without changing the size. */
function squarePng(size: number, salt = 0): Uint8Array {
  const bytes = new Uint8Array(32)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, size)
  new DataView(bytes.buffer).setUint32(20, size)
  bytes[31] = salt
  return bytes
}

const osHome = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  homedir: () => osHome.dir
}))
vi.mock('electron', () => ({ app: { getPath: () => testState.dir } }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => []),
  sshConfigHostsToTargets: vi.fn(() => [])
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

describe('BotController', () => {
  let store: Store
  let bots: BotController
  const botsRoot = () => botsRootFolder()

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-bots-profile-'))
    osHome.dir = mkdtempSync(join(tmpdir(), 'orca-bots-home-'))
    store = createStore()
    const projectGroups = new RuntimeProjectGroupController({
      getStore: () => store,
      resolveRepo: vi.fn(),
      notifyReposChanged: vi.fn(),
      resolveFolderConnectionId: () => null,
      teardownFolderWorkspacePtys: vi.fn(async () => undefined),
      acquireFileWatcherRemoval: vi.fn(async () => ({ finish: async () => undefined })),
      cleanupRemovedFolderWorkspaceState: vi.fn(),
      emitWorktreeLifecycle: vi.fn()
    })
    bots = new BotController({
      getStore: () => store,
      notifyBotsWritten: vi.fn(),
      createFolderWorkspace: async (input) =>
        (await projectGroups.createFolderWorkspace(input)).folderWorkspace,
      deleteFolderWorkspace: vi.fn(async () => undefined),
      deleteBotAutomations: vi.fn(async () => undefined),
      leaveBotGroups: vi.fn(async () => {}),
      botsRoot: () => botsRootFolder(),
      filesystem: localBotHomeFilesystem,
      forgetBot: vi.fn()
    })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
    rmSync(osHome.dir, { recursive: true, force: true })
  })

  describe('avatar revision', () => {
    it('bumps on every picture, color or outfit write, the same value again included, and not on a rename', async () => {
      const bot = await bots.create({ name: 'Reviewer', avatar: mascotAvatar('A1') })
      expect(bot.avatarRevision).toBeUndefined()

      expect((await bots.setAvatarImage(bot.id, squarePng(512))).avatarRevision).toBe(1)
      expect((await bots.update(bot.id, { avatar: mascotAvatar('A1') })).avatarRevision).toBe(2)
      expect((await bots.update(bot.id, { avatar: mascotAvatar('A1') })).avatarRevision).toBe(3)
      expect((await bots.update(bot.id, { avatarColor: '#c9b8e8' })).avatarRevision).toBe(4)
      expect((await bots.update(bot.id, { name: 'Scout' })).avatarRevision).toBe(4)
    })

    it('refuses an upload once another picture write landed since its revision, A to B to A included', async () => {
      const bot = await bots.create({ name: 'Reviewer', avatar: mascotAvatar('A1') })
      await bots.update(bot.id, { avatar: mascotAvatar('K2') })
      await bots.update(bot.id, { avatar: mascotAvatar('A1') })

      await expect(bots.setAvatarImage(bot.id, squarePng(512), 0)).rejects.toThrow(
        'bot_avatar_changed'
      )
      const after = store.getBots().find((entry) => entry.id === bot.id)
      expect(after?.avatar).toBe(mascotAvatar('A1'))
      expect(existsSync(join(botsRoot(), 'reviewer', BOT_AVATAR_FILE))).toBe(false)
      expect((await bots.setAvatarImage(bot.id, squarePng(512), 2)).avatarRevision).toBe(3)
    })

    it('lets exactly one of two uploads expecting the same revision commit', async () => {
      const bot = await bots.create({ name: 'Reviewer' })
      const custom = await bots.setAvatarImage(bot.id, squarePng(512))
      const results = await Promise.allSettled([
        bots.setAvatarImage(bot.id, squarePng(512, 1), custom.avatarRevision),
        bots.setAvatarImage(bot.id, squarePng(512, 2), custom.avatarRevision)
      ])

      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
      expect(readFileSync(join(botsRoot(), 'reviewer', BOT_AVATAR_FILE))).toEqual(
        Buffer.from(squarePng(512, 1))
      )
    })

    it('refuses an upload after a color change but not after a rename, and checks nothing without one', async () => {
      const bot = await bots.create({ name: 'Reviewer' })
      await bots.update(bot.id, { avatarColor: '#c9b8e8' })
      await expect(bots.setAvatarImage(bot.id, squarePng(512), 0)).rejects.toThrow(
        'bot_avatar_changed'
      )
      await bots.update(bot.id, { name: 'Scout' })
      expect((await bots.setAvatarImage(bot.id, squarePng(512), 1)).avatarRevision).toBe(2)
      expect((await bots.setAvatarImage(bot.id, squarePng(512, 1))).avatarRevision).toBe(3)
    })

    it('refuses an upload asked for before an outfit-only change, so the outfit wins', async () => {
      const bot = await bots.create({ name: 'Reviewer', avatar: mascotAvatar('A1') })
      const dressed = await bots.update(bot.id, { avatarOutfit: 'tie' })
      expect(dressed.avatarRevision).toBe(1)

      await expect(bots.setAvatarImage(bot.id, squarePng(512), 0)).rejects.toThrow(
        'bot_avatar_changed'
      )
      const after = store.getBots().find((entry) => entry.id === bot.id)
      expect(after?.avatar).toBe(mascotAvatar('A1'))
      expect(after?.avatarOutfit).toBe('tie')
      expect(existsSync(join(botsRoot(), 'reviewer', BOT_AVATAR_FILE))).toBe(false)
    })

    it('recovers the whole picture from a newer home after a transient failure without admitting a stale upload', async () => {
      const older = await bots.create({ name: 'Reviewer', avatar: mascotAvatar('A1') })
      await bots.update(older.id, { avatarOutfit: 'tie' })
      const saved = await bots.setAvatarImage(older.id, squarePng(512))
      const folder = join(botsRoot(), 'reviewer')
      const path = join(folder, 'bot.json')
      const healthy = readFileSync(path, 'utf8')
      store.saveBot(older)
      vi.spyOn(localBotHomeFilesystem, 'readText').mockResolvedValueOnce(null)
      try {
        await expect(bots.setAvatarImage(older.id, squarePng(512, 1), 0)).rejects.toThrow(
          'bot_avatar_home_unreadable'
        )
      } finally {
        vi.restoreAllMocks()
      }
      writeFileSync(path, JSON.stringify({ ...JSON.parse(healthy), avatarRevision: 'bad' }))
      await expect(bots.setAvatarImage(older.id, squarePng(512, 1), 0)).rejects.toThrow(
        'bot_avatar_home_unreadable'
      )
      writeFileSync(path, healthy)
      await expect(bots.setAvatarImage(older.id, squarePng(512, 1), 0)).rejects.toThrow(
        'bot_avatar_changed'
      )
      expect(readFileSync(join(folder, BOT_AVATAR_FILE))).toEqual(Buffer.from(squarePng(512)))
      expect(await bots.generationRevision(older.id, 0)).toMatchObject({ revision: 2 })
      expect(bots.list().find((entry) => entry.id === older.id)).toMatchObject({
        avatar: saved.avatar,
        avatarOutfit: 'tie',
        avatarRevision: 2
      })
      expect((await bots.setAvatarImage(older.id, squarePng(512, 2), 2)).avatarRevision).toBe(3)
    })

    it('leaves a conflicting revisionless home untouched and invalidates old tokens when its owner repairs it', async () => {
      const original = await bots.create({ name: 'Reviewer', avatar: mascotAvatar('A1') })
      const manual = squarePng(512, 1)
      const different = squarePng(512, 2)
      const before = await bots.setAvatarImage(original.id, manual)
      const folder = join(botsRoot(), 'reviewer')
      const path = join(folder, 'bot.json')
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      delete manifest.avatarRevision
      const conflict = JSON.stringify(manifest)
      writeFileSync(path, conflict)
      store.saveBot(original)
      await expect(bots.setAvatarImage(original.id, different, 0)).rejects.toThrow(
        'bot_avatar_home_unreadable'
      )
      expect(readFileSync(path, 'utf8')).toBe(conflict)
      expect(readFileSync(join(folder, BOT_AVATAR_FILE))).toEqual(Buffer.from(manual))
      rmSync(path)
      expect((await bots.update(original.id, { paused: true })).paused).toBe(true)
      expect(existsSync(path)).toBe(false)
      const repaired = await bots.setAvatarImage(original.id, manual)
      expect(repaired.avatarRevision).toBe(before.avatarRevision)
      await expect(
        bots.setAvatarImage(original.id, different, before.avatarRevision)
      ).rejects.toThrow('bot_avatar_changed')
      const fresh = await bots.generationRevision(original.id, 1, repaired.avatarRevisionEpoch)
      expect(
        (await bots.setAvatarImage(original.id, different, fresh.revision, fresh.epoch))
          .avatarRevision
      ).toBe(2)
    })

    it('restores a mascot under a look picked at its revision only while the automatic replacement is current', async () => {
      const bot = await bots.create({ name: 'Reviewer', avatar: mascotAvatar('A1') })
      const look = { avatarOutfit: 'tie', lookAtRevision: 0 }
      await bots.setAvatarImage(bot.id, squarePng(512), 0)
      expect((await bots.update(bot.id, look)).avatar).toBe(mascotAvatar('A1'))
      await bots.setAvatarImage(bot.id, squarePng(512), 2)
      const manual = await bots.setAvatarImage(bot.id, squarePng(512, 1))
      expect((await bots.update(bot.id, { ...look, lookAtRevision: 2 })).avatar).toBe(manual.avatar)
      expect(await bots.readAvatarImage(bot.id)).toEqual(Buffer.from(squarePng(512, 1)))
    })

    it("keeps the revision in the home's bot.json, so a profile that lost its last save still refuses, renamed or not", async () => {
      const bot = await bots.create({ name: 'Reviewer' })
      const saved = await bots.setAvatarImage(bot.id, squarePng(512))
      expect(
        JSON.parse(readFileSync(join(botsRoot(), 'reviewer', 'bot.json'), 'utf8')).avatarRevision
      ).toBe(1)
      // The profile's debounced write never happened: the record is back where it was.
      store.saveBot({ ...saved, avatarRevision: undefined })
      // A rename rewrites bot.json from that record, and keeps the revision.
      await bots.update(bot.id, { name: 'Reviewer Two' })

      await expect(bots.setAvatarImage(bot.id, squarePng(512, 1), 0)).rejects.toThrow(
        'bot_avatar_changed'
      )
      expect((await bots.setAvatarImage(bot.id, squarePng(512, 1), 1)).avatarRevision).toBe(2)
    })
  })
})
