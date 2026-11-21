// The bots on this computer, each homed in a folder workspace of the hidden Bots project group.
import { BOT_IMPORT_REPLY_FILE } from '../../shared/bots/bot-import'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  BOT_AVATAR_FILE,
  isBotAvatarImage,
  isUploadAvatar,
  uploadAvatar
} from '../../shared/bot-avatar'
import { type Bot, botFolderName } from '../../shared/bot-types'
import { assertBotNameFree, freeBotName } from './bot-free-name'
import { BotsDisabledError, isBotsEnabled } from '../../shared/bots-switch'
import { type BotRosterEntry, botRosterFields, soulSpecialty } from '../../shared/bot-roster'
import {
  applyBotUpdates,
  type BotCreateParams,
  type BotDeleteParams,
  type BotHostUpdates
} from '../../shared/rpc-contract/bots-params'
import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import { proposalSoul } from '../../shared/bots/bot-proposal'
import { botOfferCreation } from './bot-offer-creation'
import {
  assertBotOwnsHome,
  type BotHomeFilesystem,
  botHomeAvatarRevision,
  botHomeFolder,
  writeBotHome
} from './bot-home'
import { type BotMemoryRecord, hostBotMemoryRecord } from './bot-memory-record'
import { stampBotLinkOwners } from '../../shared/bot-link-owners'
import { makeBotsHome } from './bot-home-workspace'
import { newBotRecord } from './bot-new-record'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'

/** Where a new bot came from, kept on its record. */
export type BotOrigin = Partial<Pick<Bot, 'sharedFrom' | 'templateId'>>

type BotStore = Required<
  Pick<
    RuntimeStore,
    | 'getBots'
    | 'saveBot'
    | 'removeBot'
    | 'getProjectGroups'
    | 'createProjectGroup'
    | 'getFolderWorkspaces'
    | 'updateFolderWorkspace'
  >
> &
  Pick<RuntimeStore, 'flushPendingOrThrowAsync'>

// Its home folder is already made or gone on disk, so the record must not wait out the save debounce: a
// quit or crash inside it would bring back a deleted bot, or lose a new one's record beside its folder.
async function persistNow(store: BotStore): Promise<void> {
  await store.flushPendingOrThrowAsync?.({ drainToStableGeneration: false })
}

function isBotStore(store: RuntimeStore | null): store is RuntimeStore & BotStore {
  return Boolean(
    store?.getBots &&
    store.saveBot &&
    store.removeBot &&
    store.getProjectGroups &&
    store.createProjectGroup &&
    store.getFolderWorkspaces &&
    store.updateFolderWorkspace
  )
}

export type BotControllerDependencies = {
  getStore: () => RuntimeStore | null
  /** A bot record was saved or removed; `catalogChanged` when its home workspace was added, renamed
   *  or removed with it, which the project catalog also announces. */
  notifyBotsWritten: (catalogChanged: boolean) => void
  /** The project-group controller's own create, so path checks match any folder workspace's. */
  createFolderWorkspace: (input: {
    projectGroupId: string
    name: string
    folderPath: string
    createdWithAgent: Bot['agent']
  }) => Promise<FolderWorkspace>
  /** Ends the work held in the workspace (terminals, agent status) before it is forgotten. */
  deleteFolderWorkspace: (folderWorkspaceId: string) => Promise<unknown>
  /** Removes the automations that run as the bot, as their own delete does. */
  deleteBotAutomations: (botId: string) => Promise<void>
  /** Saved on another agent: its automations that follow it record that agent. */
  botAgentChanged?: (bot: Bot) => void
  /** Takes the bot out of every group room, as removing it from each would. */
  leaveBotGroups?: (botId: string) => Promise<void>
  botsRoot: () => string
  filesystem: BotHomeFilesystem
  /** The Orca account signed in now, recorded on the links a bot gets. */
  accountUserId?: () => string | null
  /** Drops what this host keeps for a bot outside its record (its Look around), once it is deleted. */
  forgetBot?: (botId: string) => void
}

export class BotController {
  // One change at a time: two creates must never write the same home folder.
  private tail: Promise<unknown> = Promise.resolve()

  /** Each bot's MEMORY.md as Orca last recorded it: turn ends restore against it, Forget edits it. */
  readonly memory: BotMemoryRecord

  constructor(private readonly deps: BotControllerDependencies) {
    this.memory = hostBotMemoryRecord(deps.filesystem)
  }

  /** Off, bots take no conversations or runs, and nothing creates or opens one; their homes stay. */
  enabled(): boolean {
    return isBotsEnabled(this.deps.getStore()?.getSettings())
  }

  assertEnabled(): void {
    if (!this.enabled()) {
      throw new BotsDisabledError()
    }
  }

  list(): Bot[] {
    return this.deps.getStore()?.getBots?.() ?? []
  }

  /** The list with what a client needs to draw it as this host's own sidebar does. */
  listing(): { bots: Bot[]; botsEnabled: boolean; hideBotCreatedWorkspaces: boolean } {
    return {
      bots: this.list(),
      botsEnabled: this.enabled(),
      hideBotCreatedWorkspaces: this.deps.getStore()?.getUI?.().hideBotCreatedWorkspaces !== false
    }
  }

  /** Each bot with what it is for, read from its SOUL.md now, so an edit shows at once. */
  async roster(): Promise<BotRosterEntry[]> {
    const soul = (bot: Bot) =>
      this.deps.filesystem.readText(join(botHomeFolder(bot, this.deps.botsRoot()), 'SOUL.md'))
    return Promise.all(
      this.list().map(async (bot) => ({
        ...botRosterFields(bot),
        specialty: soulSpecialty(await soul(bot))
      }))
    )
  }

  /** `origin`: made from a link (with its sharer's SOUL.md) or a built-in template; its first turn runs
   *  first-run rules like any new bot's. */
  create(input: BotCreateParams, origin?: BotOrigin): Promise<Bot> {
    return this.serialize(async () => {
      const store = this.requireStore()
      const bot = await this.makeBot(store, input, origin)
      store.saveBot(bot)
      await persistNow(store)
      this.deps.notifyBotsWritten(true)
      return bot
    })
  }

  /** One bot per offer card, with any `install` (a template's package) in the same step; see bot-offer-creation. */
  readonly createFromOffer = botOfferCreation<BotStore, BotOrigin>({
    queue: (work) => this.serialize(() => work(this.requireStore())),
    makeBot: (store, input, origin) => this.makeBot(store, input, origin),
    saved: async (store) => {
      await persistNow(store)
      this.deps.notifyBotsWritten(true)
    }
  })

  /** The new bot with its home written, not yet saved; run inside the queue. */
  private async makeBot(
    store: BotStore,
    input: BotCreateParams,
    origin: BotOrigin = {}
  ): Promise<Bot> {
    const name = freeBotName(store.getBots(), input.name)
    const draft = { ...newBotRecord({ ...input, name }, Date.now()), ...origin }
    const bot: Bot = {
      ...draft,
      ...(await makeBotsHome(
        this.deps,
        store,
        botFolderName(name),
        name,
        draft.agent,
        (path, folder) =>
          writeBotHome(
            this.deps.filesystem,
            path,
            { ...draft, folder, folderWorkspaceId: '' },
            input.seed ? proposalSoul(name, input.seed) : undefined
          )
      ))
    }
    const reply = input.importFrom?.reply?.trim()
    if (reply) {
      // The old bot's own words: read as data by the import, never sent as a turn.
      const home = botHomeFolder(bot, this.deps.botsRoot())
      await this.deps.filesystem.makeDirectory(join(home, 'import'))
      await this.deps.filesystem.writeText(join(home, BOT_IMPORT_REPLY_FILE), `${reply}\n`)
    }
    return bot
  }

  /** A hidden home for a bot group, made as a bot's is: `<bots root>/group-<slug>` in Bots. */
  createGroupHome(name: string, agent: Bot['agent']) {
    return this.serialize(() =>
      makeBotsHome(this.deps, this.requireStore(), `group-${botFolderName(name)}`, name, agent)
    )
  }

  /** A function reads the bot as saved, inside the queue, so a concurrent edit is not lost. */
  update(botId: string, edit: BotHostUpdates | ((bot: Bot) => BotHostUpdates)): Promise<Bot> {
    return this.serialize(async () => {
      const store = this.requireStore()
      const bot = this.requireBot(store, botId)
      const updates = typeof edit === 'function' ? edit(bot) : edit
      if (updates.name !== undefined) {
        assertBotNameFree(store.getBots(), updates.name, botId)
      }
      const updated: Bot = { ...applyBotUpdates(bot, updates), updatedAt: Date.now() }
      // Any picture or color choice counts, even one that sets the same value again. Every other edit
      // keeps the highest revision seen, so rewriting bot.json from a record that lost it can't lower it.
      const revision = await this.avatarRevision(bot, botHomeFolder(bot, this.deps.botsRoot()))
      if (updates.avatar !== undefined || updates.avatarColor !== undefined) {
        updated.avatarRevision = revision + 1
      } else if (revision > 0) {
        updated.avatarRevision = revision
      }
      const next = stampBotLinkOwners(bot, updated, () => this.deps.accountUserId?.() ?? null)
      await writeBotHome(this.deps.filesystem, botHomeFolder(next, this.deps.botsRoot()), next)
      if (next.name !== bot.name) {
        store.updateFolderWorkspace(bot.folderWorkspaceId, { name: next.name })
      }
      store.saveBot(next)
      this.deps.notifyBotsWritten(next.name !== bot.name)
      if (next.agent !== bot.agent) {
        this.deps.botAgentChanged?.(next)
      }
      return next
    })
  }

  /** A square PNG of at least Slack's 512 px becomes the bot's picture, kept in its home. With
   *  `expectedAvatarRevision`, refused (bot_avatar_changed, nothing written) once any other picture or
   *  color write has landed since that revision. */
  setAvatarImage(botId: string, png: Uint8Array, expectedAvatarRevision?: number): Promise<Bot> {
    return this.serialize(async () => {
      const store = this.requireStore()
      const bot = this.requireBot(store, botId)
      if (!isBotAvatarImage(png)) {
        throw new Error('bot_avatar_invalid')
      }
      const folderPath = botHomeFolder(bot, this.deps.botsRoot())
      await assertBotOwnsHome(this.deps.filesystem, folderPath, botId)
      const revision = await this.avatarRevision(bot, folderPath)
      if (expectedAvatarRevision !== undefined && expectedAvatarRevision !== revision) {
        throw new Error('bot_avatar_changed')
      }
      const version = createHash('sha256').update(png).digest('hex').slice(0, 16)
      const avatar = uploadAvatar(version)
      const next: Bot = { ...bot, avatar, avatarRevision: revision + 1, updatedAt: Date.now() }
      await this.deps.filesystem.writeBytes(join(folderPath, BOT_AVATAR_FILE), png)
      await writeBotHome(this.deps.filesystem, folderPath, next)
      store.saveBot(next)
      this.deps.notifyBotsWritten(false)
      return next
    })
  }

  /** The uploaded picture's PNG; null when the bot shows a mascot, an emoji or its initial. */
  async readAvatarImage(botId: string): Promise<Buffer | null> {
    const bot = this.requireBot(this.requireStore(), botId)
    if (!isUploadAvatar(bot.avatar)) {
      return null
    }
    return this.deps.filesystem.readBytes(
      join(botHomeFolder(bot, this.deps.botsRoot()), BOT_AVATAR_FILE)
    )
  }

  /** Not a user edit: the Chat module names which session is the bot's Chat. */
  setChatSession(botId: string, chatSessionId: string): Promise<Bot> {
    return this.serialize(async () => {
      const store = this.requireStore()
      const bot = this.requireBot(store, botId)
      const next: Bot = { ...bot, chatSessionId, updatedAt: Date.now() }
      store.saveBot(next)
      this.deps.notifyBotsWritten(false)
      return next
    })
  }

  /** Its owner's first turn in its Chat is handled, so first-run rules end; a no-op for a bot not in them. */
  endFirstRun(botId: string): Promise<void> {
    return this.serialize(async () => {
      const store = this.requireStore()
      const bot = store.getBots().find((entry) => entry.id === botId)
      if (bot?.firstRun) {
        const { firstRun: _done, ...rest } = bot
        store.saveBot({ ...rest, updatedAt: Date.now() })
        this.deps.notifyBotsWritten(false)
      }
    })
  }

  delete({ botId, deleteFolder }: BotDeleteParams): Promise<{ deleted: boolean }> {
    return this.serialize(async () => {
      const store = this.requireStore()
      const bot = this.requireBot(store, botId)
      const folderPath = botHomeFolder(bot, this.deps.botsRoot())
      if (deleteFolder) {
        await assertBotOwnsHome(this.deps.filesystem, folderPath, botId)
      }
      // First, so none starts a run in a workspace being torn down; a failure leaves the bot to retry.
      await this.deps.deleteBotAutomations(botId)
      // Before its workspace goes, so its group turns freeze and a room it anchored moves.
      await this.deps.leaveBotGroups?.(botId)
      // Missing after a by-hand removal or an earlier failed delete; either way, go on.
      if (store.getFolderWorkspaces().some((entry) => entry.id === bot.folderWorkspaceId)) {
        // Stops the workspace's processes, which could otherwise hold the folder open.
        await this.deps.deleteFolderWorkspace(bot.folderWorkspaceId)
      }
      if (deleteFolder) {
        // Before the record goes, so a failed removal can be retried.
        await this.deps.filesystem.removeTree(folderPath)
      }
      store.removeBot(bot)
      await persistNow(store)
      this.deps.forgetBot?.(bot.id)
      this.deps.notifyBotsWritten(true)
      return { deleted: true }
    })
  }

  /** The higher of the record's revision and its home's bot.json: the record saves on a debounce, so
   *  after a crash bot.json can be ahead. Read inside the queue. */
  private async avatarRevision(bot: Bot, folderPath: string): Promise<number> {
    return Math.max(
      bot.avatarRevision ?? 0,
      await botHomeAvatarRevision(this.deps.filesystem, folderPath)
    )
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.catch(() => undefined)
    return run
  }

  private requireStore(): BotStore {
    const store = this.deps.getStore()
    if (!isBotStore(store)) {
      throw new Error('runtime_unavailable')
    }
    return store
  }

  private requireBot(store: BotStore, botId: string): Bot {
    const bot = store.getBots().find((entry) => entry.id === botId)
    if (!bot) {
      throw new Error('bot_not_found')
    }
    return bot
  }
}
