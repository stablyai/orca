import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    it('bumps on every picture or color write, the same value again included, and not on a rename', async () => {
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
