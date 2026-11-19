import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeTestStores,
  createStore,
  makeRepo,
  readDataFile,
  readPersistedState,
  testState,
  writeDataFile
} from '../persistence/persistence-test-harness'
import { BotsDisabledError } from '../../shared/bots-switch'
import type { Store } from '../persistence/loading-store/store'
import { RuntimeProjectGroupController } from '../runtime/repositories/runtime-project-group-controller'
import { runtimeVisibleProjectGroups } from '../runtime/workspaces/catalog/runtime-visible-catalog'
import { readSidebarProjectCatalog } from '../runtime/sidebar-inputs/catalog/sidebar-project-catalog'
import { normalizePersistedBots } from '../../shared/bot-types'
import { BotUpdate } from '../../shared/rpc-contract/bots-params'
import { profileAccountUserId } from '../orca-profiles/profile-account-user-id'
import { linkOrcaProfileToCloud } from '../orca-profiles/cloud-auth/profile-cloud-index'
import {
  createLocalOrcaProfile,
  ensureActiveOrcaProfile,
  setActiveOrcaProfile
} from '../orca-profiles/profile-index-store'
import { botAccountSwitchBlocker } from './bot-account-switch-blocker'

function cloudFor(userId: string) {
  return { userId, cloudProfileId: `cp-${userId}`, email: `${userId}@example.test`, linkedAt: 1 }
}
import { BOT_AVATAR_FILE, mascotAvatar, parseBotAvatar } from '../../shared/bot-avatar'

/** A PNG header for a square image; `salt` changes the bytes without changing the size. */
function squarePng(size: number, salt = 0): Uint8Array {
  const bytes = new Uint8Array(32)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, size)
  new DataView(bytes.buffer).setUint32(20, size)
  bytes[31] = salt
  return bytes
}
import { deleteAutomationsOfBot } from './bot-automations-removal'
import { syncBotAutomationAgents } from './bot-automation-agent-sync'
import { RuntimeAutomationController } from '../runtime/integrations/automations/runtime-automation-controller'
import { BotController, type BotControllerDependencies } from './bot-controller'
import { botsRootFolder, localBotHomeFilesystem } from './bot-home'

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
  let notifyReposChanged: ReturnType<typeof vi.fn<(catalogChanged?: boolean) => void>>
  let deleteFolderWorkspace: ReturnType<typeof vi.fn<(id: string) => Promise<unknown>>>
  let deleteAutomation: ReturnType<typeof vi.fn<(id: string) => Promise<unknown>>>
  let deleteBotAutomations: BotControllerDependencies['deleteBotAutomations']
  let forgetBot: ReturnType<typeof vi.fn<(botId: string) => void>>
  let leaveBotGroups: ReturnType<typeof vi.fn<(botId: string) => Promise<void>>>
  let bots: BotController
  let createFolderWorkspace: BotControllerDependencies['createFolderWorkspace']
  const botsRoot = () => botsRootFolder()

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-bots-profile-'))
    osHome.dir = mkdtempSync(join(tmpdir(), 'orca-bots-home-'))
    store = createStore()
    notifyReposChanged = vi.fn<(catalogChanged?: boolean) => void>()
    deleteFolderWorkspace = vi.fn(async (id: string): Promise<unknown> => ({
      deleted: store.removeFolderWorkspace(id)
    }))
    deleteAutomation = vi.fn(async (id: string): Promise<unknown> => {
      store.deleteAutomation(id)
      return { removed: true, id }
    })
    deleteBotAutomations = (botId) =>
      deleteAutomationsOfBot(store.listAutomations(), botId, deleteAutomation)
    const projectGroups = new RuntimeProjectGroupController({
      getStore: () => store,
      resolveRepo: vi.fn(),
      notifyReposChanged,
      resolveFolderConnectionId: () => null,
      teardownFolderWorkspacePtys: vi.fn(async () => undefined),
      acquireFileWatcherRemoval: vi.fn(async () => ({ finish: async () => undefined })),
      cleanupRemovedFolderWorkspaceState: vi.fn(),
      emitWorktreeLifecycle: vi.fn()
    })
    createFolderWorkspace = async (input) =>
      (await projectGroups.createFolderWorkspace(input)).folderWorkspace
    forgetBot = vi.fn<(botId: string) => void>()
    leaveBotGroups = vi.fn(async (_botId: string) => {})
    bots = new BotController({
      getStore: () => store,
      notifyBotsWritten: notifyReposChanged,
      createFolderWorkspace,
      deleteFolderWorkspace,
      deleteBotAutomations,
      leaveBotGroups,
      botsRoot: () => botsRootFolder(),
      filesystem: localBotHomeFilesystem,
      forgetBot
    })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
    rmSync(osHome.dir, { recursive: true, force: true })
  })

  it('creates the bot, its home folder and its folder workspace on this computer', async () => {
    const bot = await bots.create({ name: 'Reviewer', agent: 'codex' })

    const folder = join(botsRoot(), 'reviewer')
    expect(existsSync(join(folder, 'SOUL.md'))).toBe(true)
    expect(bot).toMatchObject({
      name: 'Reviewer',
      hostId: 'local',
      folder: 'reviewer',
      agent: 'codex',
      slack: null,
      chatSessionId: null,
      firstRun: true
    })
    expect(bot).not.toHaveProperty('permissionMode')
    expect(store.getFolderWorkspace(bot.folderWorkspaceId)).toMatchObject({
      name: 'Reviewer',
      folderPath: folder
    })
    expect(bots.list()).toEqual([bot])
  })

  it('starts a proposed bot with its purpose in SOUL.md instead of the starter', async () => {
    await bots.create({
      name: 'Milo',
      seed: { purpose: 'Keeps a list of questions nobody has answered.', templateId: 'support' }
    })
    expect(readFileSync(join(botsRoot(), 'milo', 'SOUL.md'), 'utf8')).toBe(`# Milo

Keeps a list of questions nobody has answered.

## How I work

- Started from the Support triage template.

## Never

- Change anything (comments, labels, pull requests, posts anywhere but here) until my owner says I can. I start by reading and reporting only.
`)
  })

  it('creates one bot per card even when two accepts of it race', async () => {
    const atlas = await bots.create({ name: 'Atlas' })
    const fromOffer = { botId: atlas.id, offerId: 'offer-1' }
    const [first, second] = await Promise.all([
      bots.createFromOffer({ name: 'Release', fromOffer }),
      bots.createFromOffer({ name: 'Cutter', fromOffer })
    ])
    expect(first.existing).toBe(false)
    expect(second).toEqual({ bot: first.bot, existing: true })
    expect(bots.list().map((bot) => bot.name)).toEqual(['Atlas', 'Release'])
    expect(bots.list()[0]?.acceptedOffers).toEqual([{ offerId: 'offer-1', botId: first.bot?.id }])
  })

  it('remembers a card it created from after that bot is deleted', async () => {
    const atlas = await bots.create({ name: 'Atlas' })
    const fromOffer = { botId: atlas.id, offerId: 'offer-1' }
    const made = await bots.createFromOffer({ name: 'Cutter', fromOffer })
    await bots.delete({ botId: made.bot!.id })
    expect(await bots.createFromOffer({ name: 'Cutter', fromOffer })).toEqual({
      bot: null,
      existing: true
    })
    expect(bots.list().map((bot) => bot.name)).toEqual(['Atlas'])
  })

  it('gives a group a hidden home beside the bots', async () => {
    const bot = await bots.create({ name: 'Review' })
    const home = await bots.createGroupHome('Review', 'codex')
    const again = await bots.createGroupHome('Review', 'codex')
    expect(home.folder).toBe('group-review')
    expect(again.folder).toBe('group-review-2')
    const workspace = store.getFolderWorkspace(home.folderWorkspaceId)
    expect(workspace).toMatchObject({
      name: 'Review',
      folderPath: join(botsRoot(), 'group-review')
    })
    expect(workspace?.projectGroupId).toBe(
      store.getFolderWorkspace(bot.folderWorkspaceId)?.projectGroupId
    )
  })

  it('ends first-run setup once, and never starts it for a bot that predates it', async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    await bots.endFirstRun(bot.id)
    expect(bots.list()[0]).not.toHaveProperty('firstRun')
    const saved = bots.list()[0]
    await bots.endFirstRun(bot.id)
    expect(bots.list()[0]).toBe(saved)
  })

  it('is on unless bots are turned off, and then refuses to be used', async () => {
    expect(bots.enabled()).toBe(true)
    store.updateSettings({ botsEnabled: false })
    expect(bots.enabled()).toBe(false)
    expect(() => bots.assertEnabled()).toThrow(BotsDisabledError)
  })

  it('lists the bots with the switch and the Hide bot workspaces setting a client draws them by', async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    expect(bots.listing()).toEqual({
      bots: [bot],
      botsEnabled: true,
      hideBotCreatedWorkspaces: true
    })
    store.updateSettings({ botsEnabled: false })
    store.updateUI({ hideBotCreatedWorkspaces: false })
    expect(bots.listing()).toMatchObject({ botsEnabled: false, hideBotCreatedWorkspaces: false })
  })

  it('gives a new bot a random mascot unless it is created with a picture', async () => {
    expect(parseBotAvatar((await bots.create({ name: 'Reviewer' })).avatar)?.kind).toBe('mascot')
    expect((await bots.create({ name: 'Scout', avatar: mascotAvatar('K2') })).avatar).toBe(
      mascotAvatar('K2')
    )
  })

  it('keeps an uploaded picture in the bot’s home, versioned by its bytes', async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    const png = squarePng(512)

    const updated = await bots.setAvatarImage(bot.id, png)

    expect(parseBotAvatar(updated.avatar)?.kind).toBe('upload')
    expect(readFileSync(join(botsRoot(), 'reviewer', BOT_AVATAR_FILE))).toEqual(Buffer.from(png))
    expect(await bots.readAvatarImage(bot.id)).toEqual(Buffer.from(png))
    expect((await bots.setAvatarImage(bot.id, squarePng(512, 1))).avatar).not.toBe(updated.avatar)
    await expect(bots.setAvatarImage(bot.id, squarePng(256))).rejects.toThrow('bot_avatar_invalid')
    await expect(bots.setAvatarImage(bot.id, new Uint8Array(40))).rejects.toThrow(
      'bot_avatar_invalid'
    )
    await bots.update(bot.id, { avatar: mascotAvatar('A1') })
    expect(await bots.readAvatarImage(bot.id)).toBeNull()
  })

  it('homes every bot in one hidden Bots group', async () => {
    store.createProjectGroup({ name: 'Docs', parentPath: osHome.dir, createdFrom: 'manual' })
    const first = await bots.create({ name: 'Reviewer' })
    const second = await bots.create({ name: 'Triager' })
    const groupOf = (id: string) => store.getFolderWorkspace(id)?.projectGroupId

    expect(groupOf(first.folderWorkspaceId)).toBe(groupOf(second.folderWorkspaceId))
    expect(store.getProjectGroups().find((group) => group.parentPath === botsRoot())?.name).toBe(
      'Bots'
    )
    expect(runtimeVisibleProjectGroups(store).map((group) => group.name)).toEqual(['Docs'])
    expect(readSidebarProjectCatalog(store, []).projectGroups?.map((group) => group.name)).toEqual([
      'Docs'
    ])
  })

  it('refuses a second bot with the same name and finds a free folder for a clashing slug', async () => {
    await bots.create({ name: 'Reviewer' })
    await expect(bots.create({ name: 'reviewer' })).rejects.toThrow('bot_name_taken')

    const clash = await bots.create({ name: 'Reviewer!' })
    expect(store.getFolderWorkspace(clash.folderWorkspaceId)?.folderPath).toBe(
      join(botsRoot(), 'reviewer-2')
    )
  })

  it('names a bot made without a name "New bot", numbered past the ones already there', async () => {
    const first = await bots.create({ name: '' })
    await bots.create({ name: 'new bot 2' })
    const third = await bots.create({ name: '  ' })

    expect([first.name, third.name]).toEqual(['New bot', 'New bot 3'])
    expect(store.getFolderWorkspace(first.folderWorkspaceId)?.folderPath).toBe(
      join(botsRoot(), 'new-bot')
    )
  })

  it('renames the bot and its files but keeps its folder and soul', async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    const folder = join(botsRoot(), 'reviewer')
    writeFileSync(join(folder, 'SOUL.md'), 'Terse.\n')

    const renamed = await bots.update(bot.id, {
      name: 'Critic',
      paused: true,
      slack: { appId: 'A1', teamId: 'T1' }
    })

    expect(renamed).toMatchObject({ name: 'Critic', paused: true, slack: { appId: 'A1' } })
    expect(store.getFolderWorkspace(bot.folderWorkspaceId)).toMatchObject({
      name: 'Critic',
      folderPath: folder
    })
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toContain('You are Critic')
    expect(readFileSync(join(folder, 'SOUL.md'), 'utf8')).toBe('Terse.\n')
    await expect(bots.update('missing', { paused: true })).rejects.toThrow('bot_not_found')
  })

  it('announces a catalog change only when a home workspace is added, renamed or removed', async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    notifyReposChanged.mockClear()
    await bots.update(bot.id, { paused: true })
    await bots.setChatSession(bot.id, 'chat-2')
    await bots.endFirstRun(bot.id)
    await bots.update(bot.id, { name: 'Critic' })
    await bots.delete({ botId: bot.id, deleteFolder: false })
    expect(notifyReposChanged.mock.calls).toEqual([[false], [false], [false], [true], [true]])
  })

  it('reads the saved bot for an edit made from it, so a concurrent edit is not lost', async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    const dana = { id: 'U1', name: 'Dana', source: 'slack' }
    const lee = { id: 'U2', name: 'Lee', source: 'slack' }

    const added = bots.update(bot.id, { members: [dana, lee] })
    const removed = bots.update(bot.id, (current) => ({
      members: current.members.filter((member) => member.id !== dana.id)
    }))
    await added

    expect((await removed).members).toEqual([lee])
  })

  it('keeps the home folder on delete unless asked', async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    const folder = join(botsRoot(), 'reviewer')

    await expect(bots.delete({ botId: bot.id })).resolves.toEqual({ deleted: true })

    expect(deleteFolderWorkspace).toHaveBeenCalledWith(bot.folderWorkspaceId)
    // It leaves its group rooms while its workspace still exists.
    expect(leaveBotGroups).toHaveBeenCalledWith(bot.id)
    expect(bots.list()).toEqual([])
    // Its Look around goes with it.
    expect(forgetBot).toHaveBeenCalledWith(bot.id)
    expect(runtimeVisibleProjectGroups(store)).toEqual([])
    expect(existsSync(join(folder, 'SOUL.md'))).toBe(true)
  })

  it("deletes the bot's automations with it, and no other bot's or project's", async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    const other = await bots.create({ name: 'Critic' })
    const schedule = {
      prompt: 'Look around',
      agentId: 'claude' as const,
      projectId: '',
      workspaceMode: 'existing' as const,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.UTC(2026, 10, 1)
    }
    const asBot = (botId: string) => ({ botId, runsIn: 'new' as const, resultsTo: 'chat' as const })
    store.createAutomation({ ...schedule, name: 'Mine', bot: asBot(bot.id) })
    store.createAutomation({ ...schedule, name: 'Also mine', bot: asBot(bot.id) })
    store.createAutomation({ ...schedule, name: 'Theirs', bot: asBot(other.id) })
    store.addRepo(makeRepo())
    store.createAutomation({ ...schedule, name: 'Project', projectId: 'r1' })

    await bots.delete({ botId: bot.id })

    expect(deleteAutomation).toHaveBeenCalledTimes(2)
    expect(
      store
        .listAutomations()
        .map((entry) => entry.name)
        .sort()
    ).toEqual(['Project', 'Theirs'])
  })

  it('moves the automations that follow the bot to its new agent through the automation update', async () => {
    const automations = new RuntimeAutomationController(store, {
      showRepo: vi.fn(),
      showManagedWorktree: vi.fn()
    })
    const switching = new BotController({
      getStore: () => store,
      notifyBotsWritten: notifyReposChanged,
      createFolderWorkspace,
      deleteFolderWorkspace,
      deleteBotAutomations,
      leaveBotGroups,
      botsRoot: () => botsRootFolder(),
      filesystem: localBotHomeFilesystem,
      // As the runtime wires it.
      botAgentChanged: (bot) =>
        void syncBotAutomationAgents(store.listAutomations(), bot, (id, agentId) =>
          automations.update(id, { agentId })
        )
    })
    const bot = await switching.create({ name: 'Reviewer', agent: 'claude' })
    const schedule = {
      prompt: 'Look around',
      agentId: 'claude' as const,
      projectId: '',
      workspaceMode: 'existing' as const,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: Date.UTC(2026, 10, 1)
    }
    const target = { botId: bot.id, runsIn: 'new' as const, resultsTo: 'chat' as const }
    const follows = store.createAutomation({ ...schedule, name: 'Follows', bot: target })
    const own = store.createAutomation({
      ...schedule,
      name: 'Own',
      bot: { ...target, agentSetup: { agent: 'claude' as const } }
    })

    await switching.update(bot.id, { agent: 'codex' })

    const agentOf = (id: string) =>
      store.listAutomations().find((entry) => entry.id === id)?.agentId
    await vi.waitFor(() => expect(agentOf(follows.id)).toBe('codex'))
    expect(agentOf(own.id)).toBe('claude')
  })

  it("never reuses a folder already on disk, such as a kept or another profile's bot", async () => {
    const first = await bots.create({ name: 'Reviewer' })
    const folder = join(botsRoot(), 'reviewer')
    writeFileSync(join(folder, 'SOUL.md'), 'Terse.\n')
    await bots.delete({ botId: first.id })

    const second = await bots.create({ name: 'Reviewer' })

    expect(store.getFolderWorkspace(second.folderWorkspaceId)?.folderPath).toBe(
      join(botsRoot(), 'reviewer-2')
    )
    expect(readFileSync(join(folder, 'SOUL.md'), 'utf8')).toBe('Terse.\n')
    expect(JSON.parse(readFileSync(join(folder, 'bot.json'), 'utf8')).id).toBe(first.id)
    expect(store.getProjectGroups()).toHaveLength(1)
  })

  it('keeps writing and removing its own home when its workspace is pointed elsewhere', async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    const folder = join(botsRoot(), 'reviewer')
    const elsewhere = mkdtempSync(join(osHome.dir, 'project-'))
    store.updateFolderWorkspace(bot.folderWorkspaceId, { folderPath: elsewhere })

    await bots.update(bot.id, { name: 'Critic' })
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toContain('You are Critic')
    expect(existsSync(join(elsewhere, 'AGENTS.md'))).toBe(false)

    await bots.delete({ botId: bot.id, deleteFolder: true })
    expect(existsSync(folder)).toBe(false)
    expect(existsSync(elsewhere)).toBe(true)
  })

  it('deletes a bot whose workspace was removed by hand', async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    store.removeFolderWorkspace(bot.folderWorkspaceId)

    await expect(bots.delete({ botId: bot.id })).resolves.toEqual({ deleted: true })
    expect(bots.list()).toEqual([])
  })

  it("deletes the home folder when asked, never another bot's, and retries a partly removed one", async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    const folder = join(botsRoot(), 'reviewer')
    writeFileSync(join(folder, 'bot.json'), JSON.stringify({ id: 'someone-else' }))

    await expect(bots.delete({ botId: bot.id, deleteFolder: true })).rejects.toThrow(
      'bot_folder_not_owned'
    )
    expect(bots.list()).toHaveLength(1)

    rmSync(join(folder, 'bot.json'))
    await bots.delete({ botId: bot.id, deleteFolder: true })
    expect(existsSync(folder)).toBe(false)
  })

  it('records the signed-in account on a new link, keeps it across a restart, and leaves a link made signed out unowned', async () => {
    let accountUserId: string | null = 'user-a'
    const owned = new BotController({
      getStore: () => store,
      notifyBotsWritten: notifyReposChanged,
      createFolderWorkspace,
      deleteFolderWorkspace,
      deleteBotAutomations,
      botsRoot: () => botsRootFolder(),
      filesystem: localBotHomeFilesystem,
      accountUserId: () => accountUserId
    })
    const bot = await owned.create({ name: 'Reviewer' })

    // A client cannot name the owner: the update schema drops it, and the controller records it.
    const { updates } = BotUpdate.parse({
      botId: bot.id,
      updates: { slack: { appId: 'A1', teamId: 'T1', ownerUserId: 'user-x' } }
    })
    const linked = await owned.update(bot.id, updates)
    expect(linked.slack).toEqual({ appId: 'A1', teamId: 'T1', ownerUserId: 'user-a' })
    accountUserId = null
    const legacy = await owned.update(bot.id, { github: {} })
    expect(legacy.github).toEqual({})

    store.flush()
    await closeTestStores()

    const [reloaded] = createStore().getBots()
    expect(reloaded.slack?.ownerUserId).toBe('user-a')
    expect(reloaded.github?.ownerUserId).toBeUndefined()
  })

  it("drops owners a client names on every connector, and keeps owners through an old client's edit", async () => {
    let accountUserId: string | null = 'user-a'
    const owned = new BotController({
      getStore: () => store,
      notifyBotsWritten: notifyReposChanged,
      createFolderWorkspace,
      deleteFolderWorkspace,
      deleteBotAutomations,
      botsRoot: () => botsRootFolder(),
      filesystem: localBotHomeFilesystem,
      accountUserId: () => accountUserId
    })
    const bot = await owned.create({ name: 'Reviewer' })
    const forged = BotUpdate.parse({
      botId: bot.id,
      updates: {
        slack: { appId: 'A1', teamId: 'T1', ownerUserId: 'user-x' },
        linear: { workspaceId: 'w', workspaceName: 'W', ownerUserId: 'user-x' },
        github: { ownerUserId: 'user-x' }
      }
    })
    expect(forged.updates.slack).not.toHaveProperty('ownerUserId')
    expect(forged.updates.linear).not.toHaveProperty('ownerUserId')
    expect(forged.updates.github).not.toHaveProperty('ownerUserId')
    await owned.update(bot.id, forged.updates)

    // An older client resends links without the field, here while the host is signed out.
    accountUserId = null
    const oldClient = BotUpdate.parse({
      botId: bot.id,
      updates: { linear: { workspaceId: 'w', workspaceName: 'Renamed' }, github: {} }
    })
    const edited = await owned.update(bot.id, oldClient.updates)

    expect(edited.slack?.ownerUserId).toBe('user-a')
    expect(edited.linear).toEqual({
      workspaceId: 'w',
      workspaceName: 'Renamed',
      ownerUserId: 'user-a'
    })
    expect(edited.github?.ownerUserId).toBe('user-a')
  })

  it('keeps every Slack and Linear workspace, the first mirrored for one-workspace readers, each with its owner', async () => {
    let accountUserId: string | null = 'user-a'
    const owned = new BotController({
      getStore: () => store,
      notifyBotsWritten: notifyReposChanged,
      createFolderWorkspace,
      deleteFolderWorkspace,
      deleteBotAutomations,
      botsRoot: () => botsRootFolder(),
      filesystem: localBotHomeFilesystem,
      accountUserId: () => accountUserId
    })
    const bot = await owned.create({ name: 'Reviewer' })
    await owned.update(bot.id, { slack: { appId: 'A1', teamId: 'T1' } })
    accountUserId = 'user-b'
    const both = await owned.update(bot.id, (saved) => ({
      slackApps: [...(saved.slackApps ?? []), { appId: 'A2', teamId: 'T2' }],
      linearWorkspaces: [
        { workspaceId: 'w1', workspaceName: 'One' },
        { workspaceId: 'w2', workspaceName: 'Two' }
      ]
    }))
    expect(both.slackApps).toEqual([
      { appId: 'A1', teamId: 'T1', ownerUserId: 'user-a' },
      { appId: 'A2', teamId: 'T2', ownerUserId: 'user-b' }
    ])
    expect(both.slack).toEqual(both.slackApps?.[0])
    expect(both.linear).toEqual({ workspaceId: 'w1', workspaceName: 'One', ownerUserId: 'user-b' })

    const firstGone = await owned.update(bot.id, (saved) => ({
      slackApps: (saved.slackApps ?? []).slice(1),
      linearWorkspaces: []
    }))
    expect(firstGone.slack).toEqual({ appId: 'A2', teamId: 'T2', ownerUserId: 'user-b' })
    expect(firstGone.linear).toBeNull()
    // An older client's one-workspace edit means that workspace only.
    const single = await owned.update(bot.id, { slack: null })
    expect(single.slackApps).toEqual([])
  })

  it('keeps each Slack person in their workspace, so removing the first never hands its people on', async () => {
    const owned = new BotController({
      getStore: () => store,
      notifyBotsWritten: notifyReposChanged,
      createFolderWorkspace,
      deleteFolderWorkspace,
      deleteBotAutomations,
      botsRoot: () => botsRootFolder(),
      filesystem: localBotHomeFilesystem
    })
    const bot = await owned.create({ name: 'Reviewer' })
    // Saved before workspaces: no workspace on them.
    await owned.update(bot.id, {
      slack: { appId: 'A1', teamId: 'T1' },
      members: [{ id: 'U1', name: 'Ada', source: 'slack' }]
    })
    const both = await owned.update(bot.id, (saved) => ({
      slackApps: [...(saved.slackApps ?? []), { appId: 'A2', teamId: 'T2' }],
      members: [...saved.members, { id: 'U2', name: 'Bea', source: 'slack', workspaceId: 'T2' }]
    }))
    expect(both.members).toEqual([
      { id: 'U1', name: 'Ada', source: 'slack', workspaceId: 'T1' },
      { id: 'U2', name: 'Bea', source: 'slack', workspaceId: 'T2' }
    ])
    const firstGone = await owned.update(bot.id, (saved) => ({
      slackApps: (saved.slackApps ?? []).filter((app) => app.teamId !== 'T1')
    }))
    expect(firstGone.members).toEqual([
      { id: 'U2', name: 'Bea', source: 'slack', workspaceId: 'T2' }
    ])
    expect(
      normalizePersistedBots([
        { ...firstGone, members: [{ id: 'U3', name: 'Cy' }], slackApps: undefined }
      ])[0]?.members
    ).toEqual([{ id: 'U3', name: 'Cy', source: 'slack', workspaceId: 'T2' }])
  })

  it("keeps a profile's legacy links its own account's when an edit queued across a profile switch lands", async () => {
    const profilesDir = mkdtempSync(join(tmpdir(), 'orca-bots-profiles-'))
    try {
      const p1 = ensureActiveOrcaProfile(profilesDir).profile.id
      linkOrcaProfileToCloud(p1, cloudFor('user-a'), profilesDir)
      const p2 = createLocalOrcaProfile({ name: 'Other' }, profilesDir).profile.id
      linkOrcaProfileToCloud(p2, cloudFor('user-b'), profilesDir)
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let holdWrites = false
      let writeStarted: () => void = () => {}
      const blockedWrite = new Promise<void>((resolve) => {
        writeStarted = resolve
      })
      // This process serves P1's store, as the runtime is told at construction.
      const served = new BotController({
        getStore: () => store,
        notifyBotsWritten: notifyReposChanged,
        createFolderWorkspace,
        deleteFolderWorkspace,
        deleteBotAutomations,
        botsRoot: () => botsRootFolder(),
        filesystem: {
          ...localBotHomeFilesystem,
          writeText: async (path, text, options) => {
            if (holdWrites) {
              writeStarted()
              await held
            }
            return localBotHomeFilesystem.writeText(path, text, options)
          }
        },
        accountUserId: () => profileAccountUserId(p1, profilesDir)
      })
      const legacy = await served.create({ name: 'Legacy' })
      const other = await served.create({ name: 'Other' })
      const fresh = await served.create({ name: 'Fresh' })
      // Saved before owners were recorded.
      store.saveBot({
        ...legacy,
        slack: { appId: 'A1', teamId: 'T1' },
        linear: { workspaceId: 'w', workspaceName: 'W' },
        github: {}
      })

      holdWrites = true
      const blocking = served.update(other.id, { name: 'Other renamed' })
      const queuedEdit = served.update(legacy.id, { paused: true })
      const queuedLink = served.update(fresh.id, { slack: { appId: 'A2', teamId: 'T2' } })
      // The switch lands while the first write is held and both edits wait behind it.
      await blockedWrite
      setActiveOrcaProfile(p2, profilesDir)
      release()
      await Promise.all([blocking, queuedEdit, queuedLink])

      // Owners come from the queued edits themselves.
      const byId = (id: string) => served.list().find((bot) => bot.id === id)
      expect(byId(legacy.id)?.slack?.ownerUserId).toBe('user-a')
      expect(byId(legacy.id)?.linear?.ownerUserId).toBe('user-a')
      expect(byId(legacy.id)?.github?.ownerUserId).toBe('user-a')
      expect(byId(fresh.id)?.slack?.ownerUserId).toBe('user-a')
      const blocker = botAccountSwitchBlocker({ bots: () => served, profileId: () => p1 })
      expect(blocker.refusal('user-b', null)).toBe(
        "Remove these bots' connectors or move the bots first: Legacy, Fresh."
      )
      expect(blocker.refusal('user-a', null)).toBeNull()
    } finally {
      rmSync(profilesDir, { recursive: true, force: true })
    }
  })

  it('releases its reserved folder when a create fails', async () => {
    const failing = new BotController({
      getStore: () => store,
      notifyBotsWritten: notifyReposChanged,
      createFolderWorkspace: async () => {
        throw new Error('folder_workspace_path_unavailable')
      },
      deleteFolderWorkspace,
      deleteBotAutomations,
      botsRoot: () => botsRootFolder(),
      filesystem: localBotHomeFilesystem
    })

    await expect(failing.create({ name: 'Reviewer' })).rejects.toThrow(
      'folder_workspace_path_unavailable'
    )
    expect(existsSync(join(botsRoot(), 'reviewer'))).toBe(false)
    expect(failing.list()).toEqual([])
  })

  it('stops the workspace before removing the home, and a failed removal can be retried', async () => {
    let removals = 0
    const flaky = new BotController({
      getStore: () => store,
      notifyBotsWritten: notifyReposChanged,
      createFolderWorkspace,
      deleteFolderWorkspace,
      deleteBotAutomations,
      botsRoot: () => botsRootFolder(),
      filesystem: {
        ...localBotHomeFilesystem,
        removeTree: async (path) => {
          expect(deleteFolderWorkspace).toHaveBeenCalled()
          if (removals++ === 0) {
            throw new Error('EBUSY')
          }
          await localBotHomeFilesystem.removeTree(path)
        }
      }
    })
    const bot = await flaky.create({ name: 'Reviewer' })

    await expect(flaky.delete({ botId: bot.id, deleteFolder: true })).rejects.toThrow('EBUSY')
    expect(flaky.list()).toHaveLength(1)
    await flaky.delete({ botId: bot.id, deleteFolder: true })
    expect(flaky.list()).toEqual([])
    expect(existsSync(join(botsRoot(), 'reviewer'))).toBe(false)
  })

  it('keeps a sidebar order a drag gave across a restart, for every client to list by', async () => {
    const first = await bots.create({ name: 'Reviewer' })
    const second = await bots.create({ name: 'Scout' })
    const movedSecond = await bots.update(second.id, { sidebarOrder: 0 })
    const movedFirst = await bots.update(first.id, { sidebarOrder: 1 })
    store.flush()
    await closeTestStores()

    const reloaded = createStore()
    expect(new Map(reloaded.getBots().map((bot) => [bot.name, bot]))).toEqual(
      new Map([
        ['Reviewer', movedFirst],
        ['Scout', movedSecond]
      ])
    )
    expect(runtimeVisibleProjectGroups(reloaded)).toEqual([])
  })

  it('saves a create and a delete before answering, so a quit right after cannot undo them', async () => {
    const bot = await bots.create({ name: 'Reviewer' })
    // Read from disk with no flush, as after the app is killed inside the save debounce.
    expect(readPersistedState().bots?.map((entry) => entry.id)).toEqual([bot.id])

    await bots.delete({ botId: bot.id, deleteFolder: true })
    expect(readPersistedState().bots).toEqual([])
  })

  it('keeps the model and options picked at create, and drops them with the agent they belong to', async () => {
    const launch = { model: 'opus', options: { effort: 'high' } }
    const bot = await bots.create({
      name: 'Reviewer',
      agent: 'claude',
      launch,
      permissionMode: 'full-access'
    })
    expect(bot).toMatchObject({ launch, permissionMode: 'full-access' })
    expect(await bots.update(bot.id, { agent: 'claude' })).toMatchObject({ launch })

    const switched = await bots.update(bot.id, { agent: 'codex' })
    expect(switched).not.toHaveProperty('launch')
    expect(switched).toMatchObject({ permissionMode: 'full-access' })
    expect(await bots.update(bot.id, { launch: null })).not.toHaveProperty('launch')
    expect(await bots.update(bot.id, { launch: { model: 'gpt-5' } })).toMatchObject({
      launch: { model: 'gpt-5' }
    })
    store.flush()
    await closeTestStores()

    expect(createStore().getBots()[0]).toMatchObject({ agent: 'codex', launch: { model: 'gpt-5' } })
  })

  it('sets a permission override, and null clears it', async () => {
    const bot = await bots.create({ name: 'Reviewer' })

    expect(await bots.update(bot.id, { permissionMode: 'auto' })).toMatchObject({
      permissionMode: 'auto'
    })
    expect(await bots.update(bot.id, { permissionMode: null })).not.toHaveProperty('permissionMode')
    expect(await bots.update(bot.id, { paused: true })).not.toHaveProperty('permissionMode')
    store.flush()
    await closeTestStores()

    expect(createStore().getBots()[0]).not.toHaveProperty('permissionMode')
  })

  it('persists the legacy Ask migration once and keeps subsequent owner overrides', async () => {
    const saved = await bots.create({ name: 'Reviewer' })
    store.flush()
    await closeTestStores()
    // Settle other load migrations before testing that this migration schedules its own save.
    store = createStore()
    store.flush()
    await closeTestStores()
    const legacy = readPersistedState()
    delete legacy.botsPermissionDefaultMigrated
    const overrides = (['accept-edits', 'auto', 'full-access'] as const).map((permissionMode) => ({
      ...saved,
      id: permissionMode,
      permissionMode
    }))
    legacy.bots = [{ ...saved, permissionMode: 'ask' }, ...overrides]
    writeDataFile(legacy)

    vi.useFakeTimers()
    try {
      store = createStore()
      expect(store.getBots()).toEqual([saved, ...overrides])
      await vi.advanceTimersByTimeAsync(5000)
      await store.waitForPendingWrite()
      expect(readPersistedState()).toMatchObject({
        bots: [saved, ...overrides],
        botsPermissionDefaultMigrated: true
      })
      expect(readPersistedState().bots?.[0]).not.toHaveProperty('permissionMode')
    } finally {
      vi.useRealTimers()
    }

    await bots.update(saved.id, { permissionMode: 'ask' })
    store.flush()
    await closeTestStores()
    // Saving keeps the bot where it was.
    expect(createStore().getBots()).toEqual([
      { ...saved, permissionMode: 'ask', updatedAt: expect.any(Number) },
      ...overrides
    ])
  })

  it('loads legacy bots with no Chat or Linear link', async () => {
    const {
      chatSessionId: _chat,
      linear: _linear,
      ...saved
    } = await bots.create({
      name: 'Reviewer'
    })

    expect(normalizePersistedBots([saved])).toEqual([
      { ...saved, chatSessionId: null, linear: null }
    ])
  })

  it('saves a profile without bots exactly as before', () => {
    store.createProjectGroup({ name: 'Docs', parentPath: '/docs', createdFrom: 'manual' })
    store.flush()

    expect(readDataFile()).not.toHaveProperty('bots')
    expect(readDataFile()).not.toHaveProperty('botsPermissionDefaultMigrated')
    expect(store.getBots()).toEqual([])
  })
})
